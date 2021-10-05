import {
  createIdRemapMiddleware,
  createStreamMiddleware,
  JRPCEngine,
  JRPCRequest,
  JRPCResponse,
  JRPCSuccess,
  ObjectMultiplex,
  SafeEventEmitter,
  Stream,
} from "@toruslabs/openlogin-jrpc";
import { EthereumRpcError, ethErrors } from "eth-rpc-errors";
import dequal from "fast-deep-equal";
import { isDuplexStream } from "is-stream";
import pump from "pump";
import type { Duplex } from "readable-stream";

import { BaseProviderState, Maybe, ProviderOptions, RequestArguments, UnvalidatedJsonRpcRequest, WalletProviderState } from "./interfaces";
import log from "./loglevel";
import messages from "./messages";
import { createErrorMiddleware, logStreamDisconnectWarning } from "./utils";

// resolve response.result, reject errors
const getRpcPromiseCallback =
  (resolve, reject, unwrapResult = true) =>
  (error, response) => {
    if (error || response.error) {
      return reject(error || response.error);
    }
    return !unwrapResult || Array.isArray(response) ? resolve(response) : resolve(response.result);
  };

/**
 * @param {Object} connectionStream - A Node.js duplex stream
 * @param {Object} opts - An options bag
 * @param {number} opts.maxEventListeners - The maximum number of event listeners
 * @param {boolean} opts.shouldSendMetadata - Whether the provider should send page metadata
 */
class TorusInpageProvider extends SafeEventEmitter {
  /**
   * The chain ID of the currently connected Casper chain.
   * See [chainId.network]{@link https://chainid.network} for more information.
   */
  public chainId: string | null;

  /**
   * The user's currently selected Casper address.
   * If null, Torus is either locked or the user has not permitted any
   * addresses to be viewed.
   */
  public selectedAddress: string | null;

  protected _state: BaseProviderState;

  _rpcEngine: JRPCEngine;

  shouldSendMetadata: boolean;

  /**
   * Indicating that this provider is a Torus provider.
   */
  public readonly isTorus: true;

  protected static _defaultState: BaseProviderState = {
    accounts: null,
    isConnected: false,
    isUnlocked: false,
    initialized: false,
    isPermanentlyDisconnected: false,
    hasEmittedConnection: false,
  };

  tryWindowHandle: (payload: UnvalidatedJsonRpcRequest | UnvalidatedJsonRpcRequest[], cb: (...args: any[]) => void) => void;

  enable: () => Promise<string[]>;

  constructor(
    connectionStream: Duplex,
    { maxEventListeners = 100, shouldSendMetadata = true, jsonRpcStreamName = "provider" }: ProviderOptions = {}
  ) {
    super();
    if (!isDuplexStream(connectionStream)) {
      throw new Error(messages.errors.invalidDuplexStream());
    }
    this.isTorus = true;
    this.setMaxListeners(maxEventListeners);

    // private state
    this._state = {
      ...TorusInpageProvider._defaultState,
    };

    // public state
    this.selectedAddress = null;
    this.chainId = null;
    this.shouldSendMetadata = shouldSendMetadata;

    // bind functions (to prevent e.g. web3@1.x from making unbound calls)
    this._handleAccountsChanged = this._handleAccountsChanged.bind(this);
    this._handleChainChanged = this._handleChainChanged.bind(this);
    this._handleUnlockStateChanged = this._handleUnlockStateChanged.bind(this);
    this._handleConnect = this._handleConnect.bind(this);
    this._handleDisconnect = this._handleDisconnect.bind(this);
    this._handleStreamDisconnect = this._handleStreamDisconnect.bind(this);

    this._rpcRequest = this._rpcRequest.bind(this);
    this._initializeState = this._initializeState.bind(this);

    this.request = this.request.bind(this);
    this.sendAsync = this.sendAsync.bind(this);
    // this.enable = this.enable.bind(this);

    // setup connectionStream multiplexing
    const mux = new ObjectMultiplex();
    pump(
      connectionStream as unknown as Stream,
      mux as unknown as Stream,
      connectionStream as unknown as Stream,
      this._handleStreamDisconnect.bind(this, "Torus")
    );

    // ignore phishing warning message (handled elsewhere)
    mux.ignoreStream("phishing");

    // setup own event listeners

    // EIP-1193 connect
    this.on("connect", () => {
      this._state.isConnected = true;
    });

    // connect to async provider

    const jsonRpcConnection = createStreamMiddleware();
    pump(
      jsonRpcConnection.stream as unknown as Stream,
      mux.createStream(jsonRpcStreamName) as unknown as Stream,
      jsonRpcConnection.stream as unknown as Stream,
      this._handleStreamDisconnect.bind(this, "Torus RpcProvider")
    );

    // handle RPC requests via dapp-side rpc engine
    const rpcEngine = new JRPCEngine();
    rpcEngine.push(createIdRemapMiddleware());
    rpcEngine.push(createErrorMiddleware());
    rpcEngine.push(jsonRpcConnection.middleware);
    this._rpcEngine = rpcEngine;

    // json rpc notification listener
    jsonRpcConnection.events.on("notification", (payload) => {
      const { method, params } = payload;
      if (method === "wallet_accountsChanged") {
        this._handleAccountsChanged(params);
      } else if (method === "wallet_unlockStateChanged") {
        this._handleUnlockStateChanged(params);
      } else if (method === "wallet_chainChanged") {
        this._handleChainChanged(params);
      }
    });
  }

  /**
   * Returns whether the inpage provider is connected to Torus.
   */
  isConnected(): boolean {
    return this._state.isConnected;
  }

  /**
   * Submits an RPC request for the given method, with the given params.
   * Resolves with the result of the method call, or rejects on error.
   *
   * @param {Object} args - The RPC request arguments.
   * @param {string} args.method - The RPC method name.
   * @param {unknown[] | Object} [args.params] - The parameters for the RPC method.
   * @returns {Promise<unknown>} A Promise that resolves with the result of the RPC method,
   * or rejects if an error is encountered.
   */
  async request<T>(args: RequestArguments): Promise<Maybe<T>> {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw ethErrors.rpc.invalidRequest({
        message: messages.errors.invalidRequestArgs(),
        data: args,
      });
    }

    const { method, params } = args;

    if (typeof method !== "string" || method.length === 0) {
      throw ethErrors.rpc.invalidRequest({
        message: messages.errors.invalidRequestMethod(),
        data: args,
      });
    }

    if (params !== undefined && !Array.isArray(params) && (typeof params !== "object" || params === null)) {
      throw ethErrors.rpc.invalidRequest({
        message: messages.errors.invalidRequestParams(),
        data: args,
      });
    }

    return new Promise((resolve, reject) => {
      this._rpcRequest({ method, params }, getRpcPromiseCallback(resolve, reject));
    });
  }

  /**
   * Submits an RPC request per the given JSON-RPC request object.
   *
   * @param {Object} payload - The RPC request object.
   * @param {Function} cb - The callback function.
   */
  sendAsync(payload: JRPCRequest<unknown>, callback: (error: Error | null, result?: JRPCResponse<unknown>) => void): void {
    this._rpcRequest(payload, callback);
  }

  // Private Methods
  //= ===================
  /**
   * Constructor helper.
   * Populates initial state by calling 'wallet_getProviderState' and emits
   * necessary events.
   */
  async _initializeState(): Promise<void> {
    try {
      const { accounts, chainId, isUnlocked } = (await this.request({
        method: "wallet_getProviderState",
      })) as WalletProviderState;

      // indicate that we've connected, for EIP-1193 compliance
      this.emit("connect", { chainId });

      this._handleChainChanged({ chainId });
      this._handleUnlockStateChanged({ accounts, isUnlocked });
      this._handleAccountsChanged(accounts);
    } catch (error) {
      log.error("Torus: Failed to get initial state. Please report this bug.", error);
    } finally {
      log.info("initialized state");
      this._state.initialized = true;
      this.emit("_initialized");
    }
  }

  /**
   * Internal RPC method. Forwards requests to background via the RPC engine.
   * Also remap ids inbound and outbound
   */
  protected _rpcRequest(
    payload: UnvalidatedJsonRpcRequest | UnvalidatedJsonRpcRequest[],
    callback: (...args: any[]) => void,
    isInternal = false
  ): void {
    let cb = callback;
    const _payload = payload;
    if (!Array.isArray(_payload)) {
      if (!_payload.jsonrpc) {
        _payload.jsonrpc = "2.0";
      }

      if (_payload.method === "casper_accounts" || _payload.method === "casper_requestAccounts") {
        // handle accounts changing
        cb = (err: Error, res: JRPCSuccess<string[]>) => {
          this._handleAccountsChanged(res.result || [], _payload.method === "casper_accounts", isInternal);
          callback(err, res);
        };
      } else if (_payload.method === "wallet_getProviderState") {
        this._rpcEngine.handle(payload as JRPCRequest<unknown>, cb);
        return;
      }
    }
    this.tryWindowHandle(_payload, cb);
  }

  /**
   * When the provider becomes connected, updates internal state and emits
   * required events. Idempotent.
   *
   * @param chainId - The ID of the newly connected chain.
   * @emits TorusInpageProvider#connect
   */
  protected _handleConnect(chainId: string): void {
    if (!this._state.isConnected) {
      this._state.isConnected = true;
      this.emit("connect", { chainId });
      log.debug(messages.info.connected(chainId));
    }
  }

  /**
   * When the provider becomes disconnected, updates internal state and emits
   * required events. Idempotent with respect to the isRecoverable parameter.
   *
   * Error codes per the CloseEvent status codes as required by EIP-1193:
   * https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent#Status_codes
   *
   * @param isRecoverable - Whether the disconnection is recoverable.
   * @param errorMessage - A custom error message.
   * @emits TorusInpageProvider#disconnect
   */
  protected _handleDisconnect(isRecoverable: boolean, errorMessage?: string): void {
    if (this._state.isConnected || (!this._state.isPermanentlyDisconnected && !isRecoverable)) {
      this._state.isConnected = false;

      let error: Error;
      if (isRecoverable) {
        error = new EthereumRpcError(
          1013, // Try again later
          errorMessage || messages.errors.disconnected()
        );
        log.debug(error);
      } else {
        error = new EthereumRpcError(
          1011, // Internal error
          errorMessage || messages.errors.permanentlyDisconnected()
        );
        log.error(error);
        this.chainId = null;
        this._state.accounts = null;
        this.selectedAddress = null;
        this._state.isUnlocked = false;
        this._state.isPermanentlyDisconnected = true;
      }

      this.emit("disconnect", error);
    }
  }

  /**
   * Called when connection is lost to critical streams.
   *
   * @emits TorusInpageProvider#disconnect
   */
  protected _handleStreamDisconnect(streamName: string, error: Error): void {
    logStreamDisconnectWarning(streamName, error, this);
    this._handleDisconnect(false, error ? error.message : undefined);
  }

  /**
   * Called when accounts may have changed.
   */
  protected _handleAccountsChanged(accounts: unknown[], isEthAccounts = false, isInternal = false): void {
    // defensive programming
    let finalAccounts = accounts;
    if (!Array.isArray(finalAccounts)) {
      log.error("Torus: Received non-array accounts parameter. Please report this bug.", finalAccounts);
      finalAccounts = [];
    }

    for (const account of accounts) {
      if (typeof account !== "string") {
        log.error("Torus: Received non-string account. Please report this bug.", accounts);
        finalAccounts = [];
        break;
      }
    }

    // emit accountsChanged if anything about the accounts array has changed
    if (!dequal(this._state.accounts, finalAccounts)) {
      // we should always have the correct accounts even before casper_accounts
      // returns, except in cases where isInternal is true
      if (isEthAccounts && Array.isArray(this._state.accounts) && this._state.accounts.length > 0 && !isInternal) {
        log.error('Torus: "casper_accounts" unexpectedly updated accounts. Please report this bug.', finalAccounts);
      }

      this._state.accounts = finalAccounts as string[];
      this.emit("accountsChanged", finalAccounts);
    }

    // handle selectedAddress
    if (this.selectedAddress !== finalAccounts[0]) {
      this.selectedAddress = (finalAccounts[0] as string) || null;
    }
  }

  /**
   * Upon receipt of a new chainId and networkVersion, emits corresponding
   * events and sets relevant public state.
   * Does nothing if neither the chainId nor the networkVersion are different
   * from existing values.
   *
   * @emits TorusInpageProvider#chainChanged
   * @param networkInfo - An object with network info.
   * @param networkInfo.chainId - The latest chain ID.
   * @param networkInfo.networkVersion - The latest network ID.
   */
  protected _handleChainChanged({ chainId }: { chainId?: string } = {}): void {
    if (!chainId) {
      log.error("Torus: Received invalid network parameters. Please report this bug.", { chainId });
      return;
    }

    if (chainId === "loading") {
      this._handleDisconnect(true);
    } else {
      this._handleConnect(chainId);

      if (chainId !== this.chainId) {
        this.chainId = chainId;
        if (this._state.initialized) {
          this.emit("chainChanged", this.chainId);
        }
      }
    }
  }

  /**
   * Upon receipt of a new isUnlocked state, sets relevant public state.
   * Calls the accounts changed handler with the received accounts, or an empty
   * array.
   *
   * Does nothing if the received value is equal to the existing value.
   * There are no lock/unlock events.
   *
   * @param opts - Options bag.
   * @param opts.accounts - The exposed accounts, if any.
   * @param opts.isUnlocked - The latest isUnlocked value.
   */
  protected _handleUnlockStateChanged({ accounts, isUnlocked }: { accounts?: string[]; isUnlocked?: boolean } = {}): void {
    if (typeof isUnlocked !== "boolean") {
      log.error("Torus: Received invalid isUnlocked parameter. Please report this bug.", { isUnlocked });
      return;
    }

    if (isUnlocked !== this._state.isUnlocked) {
      this._state.isUnlocked = isUnlocked;
      this._handleAccountsChanged(accounts || []);
    }
  }
}

export default TorusInpageProvider;
