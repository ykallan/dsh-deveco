/// <reference types="node" />
import z from "@deepseek-ai/schemastery";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { Context } from "@deepseek-ai/cordis";
import { URL as URL$1, URLSearchParams as URLSearchParams$1 } from "url";
import { Duplex, Readable, Writable } from "stream";
import { EventEmitter } from "events";
import { Blob as Blob$1 } from "buffer";
import { ConnectionOptions, TLSSocket } from "tls";
import { IpcNetConnectOpts, Socket, TcpNetConnectOpts } from "net";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
/**
 * The header type declaration of `undici`.
 */
type IncomingHttpHeaders = Record<string, string | string[] | undefined>;
declare class BodyReadable extends Readable {
  constructor(resume?: (this: Readable, size: number) => void | null, abort?: () => void | null, contentType?: string);
  /** Consumes and returns the body as a string
   *  https://fetch.spec.whatwg.org/#dom-body-text
   */
  text(): Promise<string>;
  /** Consumes and returns the body as a JavaScript Object
   *  https://fetch.spec.whatwg.org/#dom-body-json
   */
  json(): Promise<unknown>;
  /** Consumes and returns the body as a Blob
   *  https://fetch.spec.whatwg.org/#dom-body-blob
   */
  blob(): Promise<Blob$1>;
  /** Consumes and returns the body as an Uint8Array
   *  https://fetch.spec.whatwg.org/#dom-body-bytes
   */
  bytes(): Promise<Uint8Array>;
  /** Consumes and returns the body as an ArrayBuffer
   *  https://fetch.spec.whatwg.org/#dom-body-arraybuffer
   */
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Not implemented
   *
   *  https://fetch.spec.whatwg.org/#dom-body-formdata
   */
  formData(): Promise<never>;
  /** Returns true if the body is not null and the body has been consumed
   *
   *  Otherwise, returns false
   *
   * https://fetch.spec.whatwg.org/#dom-body-bodyused
   */
  readonly bodyUsed: boolean;
  /**
   * If body is null, it should return null as the body
   *
   *  If body is not null, should return the body as a ReadableStream
   *
   *  https://fetch.spec.whatwg.org/#dom-body-body
   */
  readonly body: never | undefined;
  /** Dumps the response body by reading `limit` number of bytes.
   * @param opts.limit Number of bytes to read (optional) - Default: 262144
   */
  dump(opts?: {
    limit: number;
  }): Promise<void>;
}
interface BlobPropertyBag {
  type?: string;
  endings?: 'native' | 'transparent';
}
interface FilePropertyBag extends BlobPropertyBag {
  /**
   * The last modified date of the file as the number of milliseconds since the Unix epoch (January 1, 1970 at midnight). Files without a known last modified date return the current date.
   */
  lastModified?: number;
}
declare class File$1 extends Blob$1 {
  /**
   * Creates a new File instance.
   *
   * @param fileBits An `Array` strings, or [`ArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer), [`ArrayBufferView`](https://developer.mozilla.org/en-US/docs/Web/API/ArrayBufferView), [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob) objects, or a mix of any of such objects, that will be put inside the [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File).
   * @param fileName The name of the file.
   * @param options An options object containing optional attributes for the file.
   */
  constructor(fileBits: ReadonlyArray<string | NodeJS.ArrayBufferView | Blob$1>, fileName: string, options?: FilePropertyBag);
  /**
   * Name of the file referenced by the File object.
   */
  readonly name: string;
  /**
   * The last modified date of the file as the number of milliseconds since the Unix epoch (January 1, 1970 at midnight). Files without a known last modified date return the current date.
   */
  readonly lastModified: number;
  readonly [Symbol.toStringTag]: string;
}
type BodyInit = ArrayBuffer | AsyncIterable<Uint8Array> | Blob$1 | FormData$1 | Iterable<Uint8Array> | NodeJS.ArrayBufferView | URLSearchParams$1 | null | string;
interface SpecIterator<T, TReturn = any, TNext = undefined> {
  next(...args: [] | [TNext]): IteratorResult<T, TReturn>;
}
interface SpecIterableIterator<T> extends SpecIterator<T> {
  [Symbol.iterator](): SpecIterableIterator<T>;
}
interface SpecIterable<T> {
  [Symbol.iterator](): SpecIterator<T>;
}
type HeadersInit$1 = string[][] | Record<string, string | ReadonlyArray<string>> | Headers$1;
declare class Headers$1 implements SpecIterable<[string, string]> {
  constructor(init?: HeadersInit$1);
  readonly append: (name: string, value: string) => void;
  readonly delete: (name: string) => void;
  readonly get: (name: string) => string | null;
  readonly has: (name: string) => boolean;
  readonly set: (name: string, value: string) => void;
  readonly getSetCookie: () => string[];
  readonly forEach: (callbackfn: (value: string, key: string, iterable: Headers$1) => void, thisArg?: unknown) => void;
  readonly keys: () => SpecIterableIterator<string>;
  readonly values: () => SpecIterableIterator<string>;
  readonly entries: () => SpecIterableIterator<[string, string]>;
  readonly [Symbol.iterator]: () => SpecIterableIterator<[string, string]>;
}
/**
 * A `string` or `File` that represents a single value from a set of `FormData` key-value pairs.
 */
declare type FormDataEntryValue = string | File$1;
/**
 * Provides a way to easily construct a set of key/value pairs representing form fields and their values, which can then be easily sent using fetch().
 */
declare class FormData$1 {
  /**
   * Appends a new value onto an existing key inside a FormData object,
   * or adds the key if it does not already exist.
   *
   * The difference between `set()` and `append()` is that if the specified key already exists, `set()` will overwrite all existing values with the new one, whereas `append()` will append the new value onto the end of the existing set of values.
   *
   * @param name The name of the field whose data is contained in `value`.
   * @param value The field's value. This can be [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob)
    or [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File). If none of these are specified the value is converted to a string.
   * @param fileName The filename reported to the server, when a Blob or File is passed as the second parameter. The default filename for Blob objects is "blob". The default filename for File objects is the file's filename.
   */
  append(name: string, value: unknown, fileName?: string): void;
  /**
   * Set a new value for an existing key inside FormData,
   * or add the new field if it does not already exist.
   *
   * @param name The name of the field whose data is contained in `value`.
   * @param value The field's value. This can be [`Blob`](https://developer.mozilla.org/en-US/docs/Web/API/Blob)
    or [`File`](https://developer.mozilla.org/en-US/docs/Web/API/File). If none of these are specified the value is converted to a string.
   * @param fileName The filename reported to the server, when a Blob or File is passed as the second parameter. The default filename for Blob objects is "blob". The default filename for File objects is the file's filename.
   *
   */
  set(name: string, value: unknown, fileName?: string): void;
  /**
   * Returns the first value associated with a given key from within a `FormData` object.
   * If you expect multiple values and want all of them, use the `getAll()` method instead.
   *
   * @param {string} name A name of the value you want to retrieve.
   *
   * @returns A `FormDataEntryValue` containing the value. If the key doesn't exist, the method returns null.
   */
  get(name: string): FormDataEntryValue | null;
  /**
   * Returns all the values associated with a given key from within a `FormData` object.
   *
   * @param {string} name A name of the value you want to retrieve.
   *
   * @returns An array of `FormDataEntryValue` whose key matches the value passed in the `name` parameter. If the key doesn't exist, the method returns an empty list.
   */
  getAll(name: string): FormDataEntryValue[];
  /**
   * Returns a boolean stating whether a `FormData` object contains a certain key.
   *
   * @param name A string representing the name of the key you want to test for.
   *
   * @return A boolean value.
   */
  has(name: string): boolean;
  /**
   * Deletes a key and its value(s) from a `FormData` object.
   *
   * @param name The name of the key you want to delete.
   */
  delete(name: string): void;
  /**
   * Executes given callback function for each field of the FormData instance
   */
  forEach: (callbackfn: (value: FormDataEntryValue, key: string, iterable: FormData$1) => void, thisArg?: unknown) => void;
  /**
   * Returns an [`iterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols) allowing to go through all keys contained in this `FormData` object.
   * Each key is a `string`.
   */
  keys: () => SpecIterableIterator<string>;
  /**
   * Returns an [`iterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols) allowing to go through all values contained in this object `FormData` object.
   * Each value is a [`FormDataValue`](https://developer.mozilla.org/en-US/docs/Web/API/FormDataEntryValue).
   */
  values: () => SpecIterableIterator<FormDataEntryValue>;
  /**
   * Returns an [`iterator`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols) allowing to go through the `FormData` key/value pairs.
   * The key of each pair is a string; the value is a [`FormDataValue`](https://developer.mozilla.org/en-US/docs/Web/API/FormDataEntryValue).
   */
  entries: () => SpecIterableIterator<[string, FormDataEntryValue]>;
  /**
   * An alias for FormData#entries()
   */
  [Symbol.iterator]: () => SpecIterableIterator<[string, FormDataEntryValue]>;
  readonly [Symbol.toStringTag]: string;
}
declare function buildConnector(options?: buildConnector.BuildOptions): buildConnector.connector;
declare namespace buildConnector {
  export type BuildOptions = (ConnectionOptions | TcpNetConnectOpts | IpcNetConnectOpts) & {
    allowH2?: boolean;
    maxCachedSessions?: number | null;
    socketPath?: string | null;
    timeout?: number | null;
    port?: number;
    keepAlive?: boolean | null;
    keepAliveInitialDelay?: number | null;
  };
  export interface Options {
    hostname: string;
    host?: string;
    protocol: string;
    port: string;
    servername?: string;
    localAddress?: string | null;
    httpSocket?: Socket;
  }
  export type Callback = (...args: CallbackArgs) => void;
  type CallbackArgs = [null, Socket | TLSSocket] | [Error, null];
  export interface connector {
    (options: buildConnector.Options, callback: buildConnector.Callback): void;
  }
}
type ClientConnectOptions = Omit<Dispatcher.ConnectOptions, "origin">;
/**
 * A basic HTTP/1.1 client, mapped on top a single TCP/TLS connection. Pipelining is disabled by default.
 */
declare class Client extends Dispatcher {
  constructor(url: string | URL$1, options?: Client.Options);
  /** Property to get and set the pipelining factor. */
  pipelining: number;
  /** `true` after `client.close()` has been called. */
  closed: boolean;
  /** `true` after `client.destroyed()` has been called or `client.close()` has been called and the client shutdown has completed. */
  destroyed: boolean;
  // Override dispatcher APIs.
  override connect(options: ClientConnectOptions): Promise<Dispatcher.ConnectData>;
  override connect(options: ClientConnectOptions, callback: (err: Error | null, data: Dispatcher.ConnectData) => void): void;
}
declare namespace Client {
  export interface OptionsInterceptors {
    Client: readonly Dispatcher.DispatchInterceptor[];
  }
  export interface Options {
    /** TODO */
    interceptors?: OptionsInterceptors;
    /** The maximum length of request headers in bytes. Default: Node.js' `--max-http-header-size` or `16384` (16KiB). */
    maxHeaderSize?: number;
    /** The amount of time, in milliseconds, the parser will wait to receive the complete HTTP headers (Node 14 and above only). Default: `300e3` milliseconds (300s). */
    headersTimeout?: number;
    /** @deprecated unsupported socketTimeout, use headersTimeout & bodyTimeout instead */
    socketTimeout?: never;
    /** @deprecated unsupported requestTimeout, use headersTimeout & bodyTimeout instead */
    requestTimeout?: never;
    /** TODO */
    connectTimeout?: number;
    /** The timeout after which a request will time out, in milliseconds. Monitors time between receiving body data. Use `0` to disable it entirely. Default: `300e3` milliseconds (300s). */
    bodyTimeout?: number;
    /** @deprecated unsupported idleTimeout, use keepAliveTimeout instead */
    idleTimeout?: never;
    /** @deprecated unsupported keepAlive, use pipelining=0 instead */
    keepAlive?: never;
    /** the timeout, in milliseconds, after which a socket without active requests will time out. Monitors time between activity on a connected socket. This value may be overridden by *keep-alive* hints from the server. Default: `4e3` milliseconds (4s). */
    keepAliveTimeout?: number;
    /** @deprecated unsupported maxKeepAliveTimeout, use keepAliveMaxTimeout instead */
    maxKeepAliveTimeout?: never;
    /** the maximum allowed `idleTimeout`, in milliseconds, when overridden by *keep-alive* hints from the server. Default: `600e3` milliseconds (10min). */
    keepAliveMaxTimeout?: number;
    /** A number of milliseconds subtracted from server *keep-alive* hints when overriding `idleTimeout` to account for timing inaccuracies caused by e.g. transport latency. Default: `1e3` milliseconds (1s). */
    keepAliveTimeoutThreshold?: number;
    /** TODO */
    socketPath?: string;
    /** The amount of concurrent requests to be sent over the single TCP/TLS connection according to [RFC7230](https://tools.ietf.org/html/rfc7230#section-6.3.2). Default: `1`. */
    pipelining?: number;
    /** @deprecated use the connect option instead */
    tls?: never;
    /** If `true`, an error is thrown when the request content-length header doesn't match the length of the request body. Default: `true`. */
    strictContentLength?: boolean;
    /** TODO */
    maxCachedSessions?: number;
    /** TODO */
    maxRedirections?: number;
    /** TODO */
    connect?: buildConnector.BuildOptions | buildConnector.connector;
    /** TODO */
    maxRequestsPerClient?: number;
    /** TODO */
    localAddress?: string;
    /** Max response body size in bytes, -1 is disabled */
    maxResponseSize?: number;
    /** Enables a family autodetection algorithm that loosely implements section 5 of RFC 8305. */
    autoSelectFamily?: boolean;
    /** The amount of time in milliseconds to wait for a connection attempt to finish before trying the next address when using the `autoSelectFamily` option. */
    autoSelectFamilyAttemptTimeout?: number;
    /**
     * @description Enables support for H2 if the server has assigned bigger priority to it through ALPN negotiation.
     * @default false
     */
    allowH2?: boolean;
    /**
     * @description Dictates the maximum number of concurrent streams for a single H2 session. It can be overridden by a SETTINGS remote frame.
     * @default 100
     */
    maxConcurrentStreams?: number;
  }
  export interface SocketInfo {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    timeout?: number;
    bytesWritten?: number;
    bytesRead?: number;
  }
}
declare namespace Errors {
  export class UndiciError extends Error {
    name: string;
    code: string;
  }
  /** Connect timeout error. */
  export class ConnectTimeoutError extends UndiciError {
    name: 'ConnectTimeoutError';
    code: 'UND_ERR_CONNECT_TIMEOUT';
  }
  /** A header exceeds the `headersTimeout` option. */
  export class HeadersTimeoutError extends UndiciError {
    name: 'HeadersTimeoutError';
    code: 'UND_ERR_HEADERS_TIMEOUT';
  }
  /** Headers overflow error. */
  export class HeadersOverflowError extends UndiciError {
    name: 'HeadersOverflowError';
    code: 'UND_ERR_HEADERS_OVERFLOW';
  }
  /** A body exceeds the `bodyTimeout` option. */
  export class BodyTimeoutError extends UndiciError {
    name: 'BodyTimeoutError';
    code: 'UND_ERR_BODY_TIMEOUT';
  }
  export class ResponseStatusCodeError extends UndiciError {
    constructor(message?: string, statusCode?: number, headers?: IncomingHttpHeaders | string[] | null, body?: null | Record<string, any> | string);
    name: 'ResponseStatusCodeError';
    code: 'UND_ERR_RESPONSE_STATUS_CODE';
    body: null | Record<string, any> | string;
    status: number;
    statusCode: number;
    headers: IncomingHttpHeaders | string[] | null;
  }
  /** Passed an invalid argument. */
  export class InvalidArgumentError extends UndiciError {
    name: 'InvalidArgumentError';
    code: 'UND_ERR_INVALID_ARG';
  }
  /** Returned an invalid value. */
  export class InvalidReturnValueError extends UndiciError {
    name: 'InvalidReturnValueError';
    code: 'UND_ERR_INVALID_RETURN_VALUE';
  }
  /** The request has been aborted by the user. */
  export class RequestAbortedError extends UndiciError {
    name: 'AbortError';
    code: 'UND_ERR_ABORTED';
  }
  /** Expected error with reason. */
  export class InformationalError extends UndiciError {
    name: 'InformationalError';
    code: 'UND_ERR_INFO';
  }
  /** Request body length does not match content-length header. */
  export class RequestContentLengthMismatchError extends UndiciError {
    name: 'RequestContentLengthMismatchError';
    code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH';
  }
  /** Response body length does not match content-length header. */
  export class ResponseContentLengthMismatchError extends UndiciError {
    name: 'ResponseContentLengthMismatchError';
    code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH';
  }
  /** Trying to use a destroyed client. */
  export class ClientDestroyedError extends UndiciError {
    name: 'ClientDestroyedError';
    code: 'UND_ERR_DESTROYED';
  }
  /** Trying to use a closed client. */
  export class ClientClosedError extends UndiciError {
    name: 'ClientClosedError';
    code: 'UND_ERR_CLOSED';
  }
  /** There is an error with the socket. */
  export class SocketError extends UndiciError {
    name: 'SocketError';
    code: 'UND_ERR_SOCKET';
    socket: Client.SocketInfo | null;
  }
  /** Encountered unsupported functionality. */
  export class NotSupportedError extends UndiciError {
    name: 'NotSupportedError';
    code: 'UND_ERR_NOT_SUPPORTED';
  }
  /** No upstream has been added to the BalancedPool. */
  export class BalancedPoolMissingUpstreamError extends UndiciError {
    name: 'MissingUpstreamError';
    code: 'UND_ERR_BPL_MISSING_UPSTREAM';
  }
  export class HTTPParserError extends UndiciError {
    name: 'HTTPParserError';
    code: string;
  }
  /** The response exceed the length allowed. */
  export class ResponseExceededMaxSizeError extends UndiciError {
    name: 'ResponseExceededMaxSizeError';
    code: 'UND_ERR_RES_EXCEEDED_MAX_SIZE';
  }
  export class RequestRetryError extends UndiciError {
    constructor(message: string, statusCode: number, headers?: IncomingHttpHeaders | string[] | null, body?: null | Record<string, any> | string);
    name: 'RequestRetryError';
    code: 'UND_ERR_REQ_RETRY';
    statusCode: number;
    data: {
      count: number;
    };
    headers: Record<string, string | string[]>;
  }
  export class SecureProxyConnectionError extends UndiciError {
    name: 'SecureProxyConnectionError';
    code: 'UND_ERR_PRX_TLS';
  }
}
type AbortSignal$1 = unknown;
/** Dispatcher is the core API used to dispatch requests. */
declare class Dispatcher extends EventEmitter {
  /** Dispatches a request. This API is expected to evolve through semver-major versions and is less stable than the preceding higher level APIs. It is primarily intended for library developers who implement higher level APIs on top of this. */
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean;
  /** Starts two-way communications with the requested resource. */
  connect(options: Dispatcher.ConnectOptions): Promise<Dispatcher.ConnectData>;
  connect(options: Dispatcher.ConnectOptions, callback: (err: Error | null, data: Dispatcher.ConnectData) => void): void;
  /** Compose a chain of dispatchers */
  compose(dispatchers: Dispatcher.DispatcherComposeInterceptor[]): Dispatcher.ComposedDispatcher;
  compose(...dispatchers: Dispatcher.DispatcherComposeInterceptor[]): Dispatcher.ComposedDispatcher;
  /** Performs an HTTP request. */
  request(options: Dispatcher.RequestOptions): Promise<Dispatcher.ResponseData>;
  request(options: Dispatcher.RequestOptions, callback: (err: Error | null, data: Dispatcher.ResponseData) => void): void;
  /** For easy use with `stream.pipeline`. */
  pipeline(options: Dispatcher.PipelineOptions, handler: Dispatcher.PipelineHandler): Duplex;
  /** A faster version of `Dispatcher.request`. */
  stream(options: Dispatcher.RequestOptions, factory: Dispatcher.StreamFactory): Promise<Dispatcher.StreamData>;
  stream(options: Dispatcher.RequestOptions, factory: Dispatcher.StreamFactory, callback: (err: Error | null, data: Dispatcher.StreamData) => void): void;
  /** Upgrade to a different protocol. */
  upgrade(options: Dispatcher.UpgradeOptions): Promise<Dispatcher.UpgradeData>;
  upgrade(options: Dispatcher.UpgradeOptions, callback: (err: Error | null, data: Dispatcher.UpgradeData) => void): void;
  /** Closes the client and gracefully waits for enqueued requests to complete before invoking the callback (or returning a promise if no callback is provided). */
  close(): Promise<void>;
  close(callback: () => void): void;
  /** Destroy the client abruptly with the given err. All the pending and running requests will be asynchronously aborted and error. Waits until socket is closed before invoking the callback (or returning a promise if no callback is provided). Since this operation is asynchronously dispatched there might still be some progress on dispatched requests. */
  destroy(): Promise<void>;
  destroy(err: Error | null): Promise<void>;
  destroy(callback: () => void): void;
  destroy(err: Error | null, callback: () => void): void;
  on(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  on(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  on(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  on(eventName: 'drain', callback: (origin: URL$1) => void): this;
  once(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  once(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  once(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  once(eventName: 'drain', callback: (origin: URL$1) => void): this;
  off(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  off(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  off(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  off(eventName: 'drain', callback: (origin: URL$1) => void): this;
  addListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  addListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  addListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  addListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  removeListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  removeListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  removeListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  removeListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  prependListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  prependListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  prependOnceListener(eventName: 'connect', callback: (origin: URL$1, targets: readonly Dispatcher[]) => void): this;
  prependOnceListener(eventName: 'disconnect', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependOnceListener(eventName: 'connectionError', callback: (origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void): this;
  prependOnceListener(eventName: 'drain', callback: (origin: URL$1) => void): this;
  listeners(eventName: 'connect'): ((origin: URL$1, targets: readonly Dispatcher[]) => void)[];
  listeners(eventName: 'disconnect'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  listeners(eventName: 'connectionError'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  listeners(eventName: 'drain'): ((origin: URL$1) => void)[];
  rawListeners(eventName: 'connect'): ((origin: URL$1, targets: readonly Dispatcher[]) => void)[];
  rawListeners(eventName: 'disconnect'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  rawListeners(eventName: 'connectionError'): ((origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError) => void)[];
  rawListeners(eventName: 'drain'): ((origin: URL$1) => void)[];
  emit(eventName: 'connect', origin: URL$1, targets: readonly Dispatcher[]): boolean;
  emit(eventName: 'disconnect', origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError): boolean;
  emit(eventName: 'connectionError', origin: URL$1, targets: readonly Dispatcher[], error: Errors.UndiciError): boolean;
  emit(eventName: 'drain', origin: URL$1): boolean;
}
declare namespace Dispatcher {
  export interface ComposedDispatcher extends Dispatcher {}
  export type DispatcherComposeInterceptor = (dispatch: Dispatcher['dispatch']) => Dispatcher['dispatch'];
  export interface DispatchOptions {
    origin?: string | URL$1;
    path: string;
    method: HttpMethod;
    /** Default: `null` */
    body?: string | Buffer | Uint8Array | Readable | null | FormData$1;
    /** Default: `null` */
    headers?: IncomingHttpHeaders | string[] | Iterable<[string, string | string[] | undefined]> | null;
    /** Query string params to be embedded in the request URL. Default: `null` */
    query?: Record<string, any>;
    /** Whether the requests can be safely retried or not. If `false` the request won't be sent until all preceding requests in the pipeline have completed. Default: `true` if `method` is `HEAD` or `GET`. */
    idempotent?: boolean;
    /** Whether the response is expected to take a long time and would end up blocking the pipeline. When this is set to `true` further pipelining will be avoided on the same connection until headers have been received. */
    blocking?: boolean;
    /** Upgrade the request. Should be used to specify the kind of upgrade i.e. `'Websocket'`. Default: `method === 'CONNECT' || null`. */
    upgrade?: boolean | string | null;
    /** The amount of time, in milliseconds, the parser will wait to receive the complete HTTP headers. Defaults to 300 seconds. */
    headersTimeout?: number | null;
    /** The timeout after which a request will time out, in milliseconds. Monitors time between receiving body data. Use 0 to disable it entirely. Defaults to 300 seconds. */
    bodyTimeout?: number | null;
    /** Whether the request should stablish a keep-alive or not. Default `false` */
    reset?: boolean;
    /** Whether Undici should throw an error upon receiving a 4xx or 5xx response from the server. Defaults to false */
    throwOnError?: boolean;
    /** For H2, it appends the expect: 100-continue header, and halts the request body until a 100-continue is received from the remote server*/
    expectContinue?: boolean;
  }
  export interface ConnectOptions {
    origin: string | URL$1;
    path: string;
    /** Default: `null` */
    headers?: IncomingHttpHeaders | string[] | null;
    /** Default: `null` */
    signal?: AbortSignal$1 | EventEmitter | null;
    /** This argument parameter is passed through to `ConnectData` */
    opaque?: unknown;
    /** Default: 0 */
    maxRedirections?: number;
    /** Default: false */
    redirectionLimitReached?: boolean;
    /** Default: `null` */
    responseHeader?: 'raw' | null;
  }
  export interface RequestOptions extends DispatchOptions {
    /** Default: `null` */
    opaque?: unknown;
    /** Default: `null` */
    signal?: AbortSignal$1 | EventEmitter | null;
    /** Default: 0 */
    maxRedirections?: number;
    /** Default: false */
    redirectionLimitReached?: boolean;
    /** Default: `null` */
    onInfo?: (info: {
      statusCode: number;
      headers: Record<string, string | string[]>;
    }) => void;
    /** Default: `null` */
    responseHeader?: 'raw' | null;
    /** Default: `64 KiB` */
    highWaterMark?: number;
  }
  export interface PipelineOptions extends RequestOptions {
    /** `true` if the `handler` will return an object stream. Default: `false` */
    objectMode?: boolean;
  }
  export interface UpgradeOptions {
    path: string;
    /** Default: `'GET'` */
    method?: string;
    /** Default: `null` */
    headers?: IncomingHttpHeaders | string[] | null;
    /** A string of comma separated protocols, in descending preference order. Default: `'Websocket'` */
    protocol?: string;
    /** Default: `null` */
    signal?: AbortSignal$1 | EventEmitter | null;
    /** Default: 0 */
    maxRedirections?: number;
    /** Default: false */
    redirectionLimitReached?: boolean;
    /** Default: `null` */
    responseHeader?: 'raw' | null;
  }
  export interface ConnectData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    socket: Duplex;
    opaque: unknown;
  }
  export interface ResponseData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: BodyReadable & BodyMixin;
    trailers: Record<string, string>;
    opaque: unknown;
    context: object;
  }
  export interface PipelineHandlerData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    opaque: unknown;
    body: BodyReadable;
    context: object;
  }
  export interface StreamData {
    opaque: unknown;
    trailers: Record<string, string>;
  }
  export interface UpgradeData {
    headers: IncomingHttpHeaders;
    socket: Duplex;
    opaque: unknown;
  }
  export interface StreamFactoryData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    opaque: unknown;
    context: object;
  }
  export type StreamFactory = (data: StreamFactoryData) => Writable;
  export interface DispatchHandlers {
    /** Invoked before request is dispatched on socket. May be invoked multiple times when a request is retried when the request at the head of the pipeline fails. */
    onConnect?(abort: (err?: Error) => void): void;
    /** Invoked when an error has occurred. */
    onError?(err: Error): void;
    /** Invoked when request is upgraded either due to a `Upgrade` header or `CONNECT` method. */
    onUpgrade?(statusCode: number, headers: Buffer[] | string[] | null, socket: Duplex): void;
    /** Invoked when response is received, before headers have been read. **/
    onResponseStarted?(): void;
    /** Invoked when statusCode and headers have been received. May be invoked multiple times due to 1xx informational headers. */
    onHeaders?(statusCode: number, headers: Buffer[], resume: () => void, statusText: string): boolean;
    /** Invoked when response payload data is received. */
    onData?(chunk: Buffer): boolean;
    /** Invoked when response payload and trailers have been received and the request has completed. */
    onComplete?(trailers: string[] | null): void;
    /** Invoked when a body chunk is sent to the server. May be invoked multiple times for chunked requests */
    onBodySent?(chunkSize: number, totalBytesSent: number): void;
  }
  export type PipelineHandler = (data: PipelineHandlerData) => Readable;
  export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'CONNECT' | 'OPTIONS' | 'TRACE' | 'PATCH';
  /**
   * @link https://fetch.spec.whatwg.org/#body-mixin
   */
  interface BodyMixin {
    readonly body?: never;
    readonly bodyUsed: boolean;
    arrayBuffer(): Promise<ArrayBuffer>;
    blob(): Promise<Blob$1>;
    bytes(): Promise<Uint8Array>;
    formData(): Promise<never>;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }
  export interface DispatchInterceptor {
    (dispatch: Dispatcher['dispatch']): Dispatcher['dispatch'];
  }
}
/** The scope associated with a mock dispatch. */
declare class MockScope<TData extends object = object> {
  constructor(mockDispatch: MockInterceptor.MockDispatch<TData>);
  /** Delay a reply by a set amount of time in ms. */
  delay(waitInMs: number): MockScope<TData>;
  /** Persist the defined mock data for the associated reply. It will return the defined mock data indefinitely. */
  persist(): MockScope<TData>;
  /** Define a reply for a set amount of matching requests. */
  times(repeatTimes: number): MockScope<TData>;
}
/** The interceptor for a Mock. */
declare class MockInterceptor {
  constructor(options: MockInterceptor.Options, mockDispatches: MockInterceptor.MockDispatch[]);
  /** Mock an undici request with the defined reply. */
  reply<TData extends object = object>(replyOptionsCallback: MockInterceptor.MockReplyOptionsCallback<TData>): MockScope<TData>;
  reply<TData extends object = object>(statusCode: number, data?: TData | Buffer | string | MockInterceptor.MockResponseDataHandler<TData>, responseOptions?: MockInterceptor.MockResponseOptions): MockScope<TData>;
  /** Mock an undici request by throwing the defined reply error. */
  replyWithError<TError extends Error = Error>(error: TError): MockScope;
  /** Set default reply headers on the interceptor for subsequent mocked replies. */
  defaultReplyHeaders(headers: IncomingHttpHeaders): MockInterceptor;
  /** Set default reply trailers on the interceptor for subsequent mocked replies. */
  defaultReplyTrailers(trailers: Record<string, string>): MockInterceptor;
  /** Set automatically calculated content-length header on subsequent mocked replies. */
  replyContentLength(): MockInterceptor;
}
declare namespace MockInterceptor {
  /** MockInterceptor options. */
  export interface Options {
    /** Path to intercept on. */
    path: string | RegExp | ((path: string) => boolean);
    /** Method to intercept on. Defaults to GET. */
    method?: string | RegExp | ((method: string) => boolean);
    /** Body to intercept on. */
    body?: string | RegExp | ((body: string) => boolean);
    /** Headers to intercept on. */
    headers?: Record<string, string | RegExp | ((body: string) => boolean)> | ((headers: Record<string, string>) => boolean);
    /** Query params to intercept on */
    query?: Record<string, any>;
  }
  export interface MockDispatch<TData extends object = object, TError extends Error = Error> extends Options {
    times: number | null;
    persist: boolean;
    consumed: boolean;
    data: MockDispatchData<TData, TError>;
  }
  export interface MockDispatchData<TData extends object = object, TError extends Error = Error> extends MockResponseOptions {
    error: TError | null;
    statusCode?: number;
    data?: TData | string;
  }
  export interface MockResponseOptions {
    headers?: IncomingHttpHeaders;
    trailers?: Record<string, string>;
  }
  export interface MockResponseCallbackOptions {
    path: string;
    method: string;
    headers?: Headers$1 | Record<string, string>;
    origin?: string;
    body?: BodyInit | Dispatcher.DispatchOptions['body'] | null;
    maxRedirections?: number;
  }
  export type MockResponseDataHandler<TData extends object = object> = (opts: MockResponseCallbackOptions) => TData | Buffer | string;
  export type MockReplyOptionsCallback<TData extends object = object> = (opts: MockResponseCallbackOptions) => {
    statusCode: number;
    data?: TData | Buffer | string;
    responseOptions?: MockResponseOptions;
  };
}
/**
 * DevEco 模型目录。
 *
 * **目录只放上游给的东西。** 唯一来源是动态发现（`discovery.ts` → `codeGenie/modelConfig`）：
 * 启动时、每小时、以及卡片上「刷新模型」各拉一次，取所有成功账号的并集。
 * 上游没返回的模型就是没有，未登录时目录为空 —— 不拿一份历史名单冒充「可用模型」。
 *
 * `FALLBACK_PARAMS` 因此**不往目录里塞模型**，只是一张按上游 id 的参数表，给发现到的
 * 模型补 `contextWindow` / `maxTokens` / 视觉能力。上游有时不给这些字段，而写错的
 * `maxTokens` 会让每个请求直接失败。
 *
 * @module dsh-deveco/catalog
 */
/** 上游声明的思考强度。 */
interface DevecoModelThinking {
  /** 可选档位（上游 `reasoning_effort.level` 的原值，如 `['low','high','max']`）。 */
  levels: readonly string[];
  /** 上游默认档位。 */
  default?: string;
}
/** 一个暴露给 DSH 的模型。 */
interface DevecoModelInfo {
  /** 对外 id（`GLM-5.1-DevEco`；没有改名的模型与 `wireId` 相同）。 */
  id: string;
  /** 上游 wire id（`GLM-5.1`）—— 请求里必须发这个。 */
  wireId: string;
  /** 展示名。 */
  name: string;
  contextWindow: number;
  /** `contextWindow` 是上游真的给的，还是兜底值。卡片只在真值时印规格。 */
  contextWindowKnown?: boolean;
  maxTokens: number;
  supportsImages: boolean;
  /** 是不是思考模型（上游 `thinking_mode === 'on'`）。 */
  reasoning?: boolean;
  /** 支持工具调用（上游 `tool_call_mode === 'tool_calls'`）。 */
  toolCall?: boolean;
  /** 上游声明的思考档位。空/缺省 = 不显示推理档位选择器。 */
  thinking?: DevecoModelThinking;
  /** 不在上游目录里、但确实能调的隐藏模型。 */
  hidden?: boolean;
}
/**
 * 参数表（**不是**模型名单）。
 *
 * 只给**发现到的**模型补参数，绝不会因为这里有条目就把模型塞进目录。
 */
declare const FALLBACK_PARAMS: readonly DevecoModelInfo[];
/** 隐藏模型：上游目录里没有，但确实能调。 */
declare const HIDDEN_MODELS: readonly DevecoModelInfo[];
/** 可变目录，由 shim 的 `/v1/models` 与适配器共享。 */
declare class DevecoCatalog {
  /** 空目录起步：没发现过就是没有模型。 */
  private models;
  current(): readonly DevecoModelInfo[];
  set(models: readonly DevecoModelInfo[]): void;
  /** 按对外 id 或上游 id 找一条（大小写不敏感）。 */
  find(id: string): DevecoModelInfo | undefined;
}
/** 把目录收窄到用户勾选的子集（空/缺省 = 全给）。 */
declare function filterEnabledModels(models: readonly DevecoModelInfo[], enabled: readonly string[] | undefined): readonly DevecoModelInfo[];
/**
 * 合并多路来源（多账号）的模型清单。
 *
 * 规则：
 *  - 按上游 id 去重（上游注册名大小写敏感，但同一模型书写可能不一致）；
 *  - 参数更全的一条优先（有真窗口 > 兜底窗口，支持图片 > 不支持）；
 *  - 输出按对外 id 排序，保证刷新前后顺序稳定。
 */
declare function mergeModelLists(sets: readonly (readonly DevecoModelInfo[])[]): readonly DevecoModelInfo[];
/** 一条 DevEco 账号凭证。 */
interface DevecoCredential {
  /** 长寿命 JWT，所有其它凭证都由它换来。 */
  jwtToken: string;
  /** JWT 里的 `userId`，账号自然键的首选。 */
  userId?: string;
  /** JWT 里的 `userName`，展示用。 */
  userName?: string;
  /** `CN` = 中国大陆账号（上游只服务这个区域）。 */
  nationalCode?: string;
  /** 是否实名（未实名不能调上游）。 */
  isRealName?: boolean;
  /** 短寿命访问令牌。 */
  accessToken?: string;
  /** 访问令牌到期时刻（epoch ms，按学到的 TTL 推算）。 */
  accessTokenExpiresAt?: number;
  /** 当前 accessToken 的签发时刻（epoch ms）—— 学习 TTL 的基准。 */
  accessTokenIssuedAt?: number;
  /** 学到的「签发后多久被上游拒绝」样本（毫秒，最多保留 5 个）。 */
  ttlSamplesMs?: number[];
  /** 观测到的「签发后仍然可用」的最大时长（TTL 下界）。 */
  workingAgeMs?: number;
  /** 上游给的刷新令牌（有就带着，目前只用于诊断）。 */
  refreshToken?: string;
  /** 用户可改的备注名。 */
  label?: string;
  /** 首次落库时间。 */
  storedAt?: number;
  /** 最近一次成功登录时间。 */
  lastLoginAt?: number;
  /** 续期被上游拒绝，需要重新登录。 */
  stale?: boolean;
  /** 用户手动暂停（不参与轮转）。 */
  paused?: boolean;
  /** 用户置顶（轮转优先）。 */
  pinned?: boolean;
}
/** 卡片上一条账号摘要（**不含任何令牌**）。 */
interface DevecoAccountSummary {
  id: string;
  label?: string;
  userName?: string;
  userId?: string;
  nationalCode?: string;
  isRealName: boolean;
  /** 凭证还能不能用（没被标记 stale）。 */
  usable: boolean;
  /** 访问令牌何时过期（epoch ms），没有则是 undefined。 */
  accessTokenExpiresAt?: number;
  storedAt?: number;
  lastLoginAt?: number;
  /** JWT 自身何时过期（epoch ms）。 */
  jwtExpiresAt?: number;
  /** 当前生效的 accessToken 寿命（毫秒，学到的或默认）。 */
  ttlMs: number;
  /** TTL 结论来自哪里：learned（上界样本）/ extended（下界抬高）/ default。 */
  ttlSource: 'learned' | 'extended' | 'default';
  /** 参与计算的「被拒」样本数。 */
  ttlSamples: number;
  /** 当前 accessToken 已经用了多久（毫秒）。 */
  tokenAgeMs?: number;
  paused: boolean;
  pinned: boolean;
}
/** 解析出来的 JWT 载荷子集。 */
interface DevecoJwtPayload {
  userId?: string;
  userName?: string;
  exp?: number;
  iat?: number;
  nationalCode?: string;
  isRealName?: boolean;
}
/** 一次凭证解析的结果：够发一次聊天请求。 */
interface ResolvedDevecoCredential {
  id: string;
  credential: DevecoCredential;
  accessToken: string;
  /** 认过证的账号身份（JWT 解析结果）。 */
  userName?: string;
  userId?: string;
}
/** 多账号文档路径。 */
declare function devecoAccountsPath(home?: string): string;
/** 签到台账路径。 */
declare function devecoCheckinPath(home?: string): string;
/** 用量台账路径。 */
declare function devecoUsagePath(home?: string): string;
/** 解析 JWT 载荷。**不验签**：上游的签名密钥我们拿不到，也没必要验。 */
declare function parseJwtPayload(token: string): DevecoJwtPayload;
/**
 * 多账号凭证文档。
 *
 * 文档本身只管「存了什么」；能不能用由池和 slot 决定。
 */
declare class DevecoAccountStore {
  private readonly path;
  private readonly log?;
  private document;
  private loading;
  private readonly slots;
  constructor(path: string, options?: {
    log?: (message: string) => void;
  });
  /** 当前磁盘路径（部署/诊断用）。 */
  get documentPath(): string;
  private ensureLoaded;
  private load;
  private get doc();
  private flush;
  private slot;
  /** 账号摘要列表（按文档顺序）。 */
  list(): Promise<DevecoAccountSummary[]>;
  /** 账号 id 列表（文档顺序）。 */
  ids(): Promise<string[]>;
  /** 账号 id 列表，但按当前凭证可用性过滤（stale 的不参与轮转）。 */
  dispatchIds(): Promise<string[]>;
  /** 某个账号的凭证副本。 */
  credential(id: string): Promise<DevecoCredential | undefined>;
  /** 第一个可用账号的凭证。 */
  current(): Promise<{
    id: string;
    credential: DevecoCredential;
  } | undefined>;
  /** 有没有任何账号。 */
  hasCredential(): Promise<boolean>;
  /** 写入/更新一个账号，返回账号 id。 */
  upsert(credential: DevecoCredential, id?: string): Promise<string>;
  /** 删除一个账号。 */
  remove(id: string): Promise<void>;
  /** 清空所有账号。 */
  clear(): Promise<void>;
  /** 暂停/恢复一个账号。 */
  setPaused(id: string, paused: boolean): Promise<boolean>;
  /** 置顶/取消置顶一个账号。 */
  setPinned(id: string, pinned: boolean): Promise<boolean>;
  /** 改备注名。 */
  setLabel(id: string, label: string): Promise<boolean>;
  /**
   * 解析一个账号，拿到可直接用的访问令牌（必要时静默续期）。
   *
   * @returns 解析结果；账号不存在、被暂停或确实需要重新登录时 undefined。
   */
  resolve(id: string): Promise<ResolvedDevecoCredential | undefined>;
  /** 强制续期一个账号（卡片上的「刷新凭证」按钮）。 */
  forceRefresh(id: string): Promise<boolean>;
  /** 上游明确拒了这条凭证：标成 stale，等用户重新登录。 */
  markRejected(id: string, reason: string): Promise<void>;
  /**
   * 上游拿这张 accessToken 回了 401 —— 交给 slot 记一个 TTL 上界样本。
   *
   * 只采样、不改账号状态：是否判死由调用方根据「刷新能否成功」决定。
   */
  noteTokenWorked(id: string, issuedAt?: number): Promise<void>;
  noteTokenExpired(id: string): Promise<void>;
  /** 从磁盘重读（另一个进程/用户手工改了文档时）。 */
  reloadFromDisk(): Promise<boolean>;
  /**
   * 保活：把所有「访问令牌快过期」的账号提前续掉。
   *
   * 这一轮**只续 accessToken**，不动 jwtToken 的寿命 —— jwtToken 什么时候过期由上游
   * 决定，过期只能重新登录。它的价值是：DSH 开机放一整天不聊天时，第一个请求不必
   * 先等一次续期，同时把「哪个号已经废了」提前暴露在卡片上。
   */
  /**
   * @param options.skip 返回 true 的账号本轮不碰。
   *
   * 后台续期最忌讳「账号正有请求在飞时给它换令牌」：很多网关签发新 accessToken 就会让
   * 旧的那张失效，正在流式输出的请求会当场被上游判「密钥无效」而中断 —— 这正是
   * 「推理到一半突然密钥无效」的典型来源。所以有在飞请求的账号一律跳过，等它空下来。
   */
  keepAlive(options?: {
    skip?: (id: string) => boolean;
  }): Promise<{
    checked: number;
    refreshed: number;
    needsLogin: string[];
  }>;
}
/** 池里一个账号的运行时状态。 */
interface AccountRuntime {
  id: string;
  /** 我们这边正在飞的请求数。 */
  activeConcurrent: number;
  maxConcurrent: number;
  /** 冷却截止时间（epoch ms）；0 = 没在冷却。 */
  coolUntil: number;
  /** 凭据失效等硬错误：停用，等用户重新登录。 */
  disabled: boolean;
  lastError?: string;
  /** 上次被选中的时间，用于「最久未用优先」。 */
  lastUsed: number;
  errorCount: number;
}
interface PoolOptions {
  maxConcurrent?: number;
  /** 可注入的时钟，便于测试。 */
  now?: () => number;
}
declare class DevecoAccountPool {
  private readonly accounts;
  /** 用户手动暂停的账号：运行时状态留着（卡片还看得见槽位），但不参与轮转。 */
  private readonly paused;
  /** 用户置顶的账号：选号时排在最前面。 */
  private readonly preferred;
  private readonly maxConcurrent;
  private readonly now;
  /** 等槽位的唤醒器：槽位释放 / 池里新增账号 / 账号复活时逐个唤醒。 */
  private readonly waiters;
  constructor(ids: readonly string[], options?: PoolOptions);
  /** 让池与账号文档对齐：新增的进来，删掉的出去。已有账号的运行时状态保留。 */
  sync(ids: readonly string[]): void;
  list(): AccountRuntime[];
  get(id: string): AccountRuntime | undefined;
  /** 账号本身可用（没被禁用、不在冷却中）。 */
  healthy(id: string): boolean;
  /** 现在就能接活的账号：置顶优先，其余按「最久未用」。 */
  private available;
  /** 设置暂停集合（账号 id）。 */
  setPaused(ids: readonly string[]): void;
  pausedIds(): string[];
  /** 设置置顶集合（账号 id）。置顶只在「同时可用」时改变先后，不绕过冷却/上限。 */
  setPreferred(ids: readonly string[]): void;
  preferredIds(): string[];
  /** 选一个账号（跳过 `exclude` 里的）。 */
  pick(exclude?: ReadonlySet<string>): string | undefined;
  /** 占一个本地槽位。占用失败（已满/不存在）返回 false。 */
  acquire(id: string): boolean;
  /** 释放槽位；重复释放不会把计数压到负数。 */
  release(id: string): void;
  private notifyWaiters;
  /** 现在是否有一个真正能接活的空槽位。 */
  hasFreeSlot(): boolean;
  /** 有没有「健康、但本地槽位被占满」的号 —— 只有这种值得等一会儿。 */
  hasBusyWaitable(): boolean;
  /** 等一个本地槽位空出来，最多 `maxWaitMs`。 */
  waitForFreeSlot(maxWaitMs: number, signal?: AbortSignal): Promise<boolean>;
  /** 凭据失效等硬错误：直接停用，等用户重新登录。 */
  disable(id: string, reason: string): void;
  /** 用户重新登录后调用：把账号从禁用/冷却里捞出来。 */
  revive(id: string): void;
  /** 上游 5xx / 软限流：短时冷却。 */
  cooldown(id: string, ms: number, reason: string): void;
  /** 累计错误；达到阈值就冷却。 */
  noteError(id: string, threshold: number, cooldownMs: number, reason: string): void;
  /** 一次成功：清掉错误计数与冷却。 */
  noteSuccess(id: string): void;
  /** 有没有任何账号可用（含被暂停之外的）。 */
  hasUsable(): boolean;
}
/** 一个额度窗口。 */
interface QuotaWindow {
  /** 窗口键（窗口开始那天，`YYYY-MM-DD`）。 */
  key: string;
  /** 窗口开始时刻（epoch ms）。 */
  start: number;
  /** 下一次重置时刻（epoch ms）。 */
  end: number;
  /** 展示用：`11-15 08:00 → 11-16 08:00`。 */
  label: string;
}
/** 单个账号在本窗口内的额度状态。 */
interface QuotaAccountState {
  id: string;
  /** 属于哪个窗口；窗口一换旧状态作废。 */
  window: string;
  /** 上游在本窗口内明确说过「额度用尽」。 */
  exhausted: boolean;
  /** 最近一次判定的时刻。 */
  at: number;
  /** 上游给的原文（诊断用，可能为空）。 */
  message?: string;
  /** 上游承诺的重置时刻（epoch ms），从原文解析；解析不到就是 undefined。 */
  resetAt?: number;
}
/** 给卡片用的额度快照。 */
interface QuotaSnapshot {
  window: QuotaWindow;
  /** 距离重置还剩多少毫秒。 */
  resetInMs: number;
  /** 距离重置还剩多久（已格式化）。 */
  resetIn: string;
  /** 本窗口内被上游挡过的账号 id。 */
  exhausted: string[];
  /**
   * 上游承诺的**最早**恢复时刻（epoch ms）。
   *
   * 拿得到时界面就说「额度已用尽，XX 重置」，而不是让用户盯着 08:00 的窗口去猜。
   */
  exhaustedUntil?: number;
  /** 各账号的状态（只包含被记录过的）。 */
  accounts: Record<string, QuotaAccountState>;
  /**
   * 上游有没有「剩余额度」接口。恒为 false，写进数据里是为了让界面不必猜、也不必
   * 硬编码一句会被改掉的文案。
   */
  hasUpstreamEndpoint: false;
}
/**
 * 记录「谁的额度用尽了」。
 *
 * 只活在内存里：窗口一换所有状态作废，重启后重新学习。刻意不落盘 —— 一个过期状态被
 * 当成事实显示在卡片上，比「暂时不知道」更糟。
 */
declare class DevecoQuotaTracker {
  private readonly states;
  private readonly now;
  constructor(options?: {
    now?: () => number;
  });
  /** 上游判了这个账号本窗口的额度用尽。 */
  noteExhausted(id: string, message: string): void;
  /** 一次成功 = 这个号本窗口没被卡住（同时把过期的「用尽」清掉）。 */
  noteOk(id: string): void;
  /** 某账号本窗口的状态（跨窗口的旧记录视为没有）。 */
  state(id: string): QuotaAccountState | undefined;
  /** 快照（`ids` 用于计算「有哪些号被挡过」，顺序稳定）。 */
  snapshot(ids: readonly string[], now?: number): QuotaSnapshot;
}
/**
 * 本机用量台账。
 *
 * 只记**本机经这个插件发出去的**请求：上游不提供用量接口（见 `docs/PROTOCOL.md` 第 6 节），
 * 所以「今天用了多少」只能自己攒。它是估算的、不完整的（其它设备/IDE 的用量不在里面），
 * 卡片上必须这么标，不能写成「账号总额度」。
 *
 * 口径：
 *  - `requests` 发出去的生成请求数（含失败）；
 *  - `inputTokens` / `outputTokens` 来自上游响应体里的 `usage`（流式取最后一个带的块）；
 *  - `today` 按**额度窗口**归零（上游每天在固定整点重置免费额度，不是自然日零点，
 *    见 `quota.ts`），同时保留 `totals` 全量。
 *
 * @module dsh-deveco/usage
 */
/** 累计计数。 */
interface UsageTotals {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}
/** 一条最近请求记录（不含任何内容）。 */
interface UsageEvent {
  at: number;
  account: string;
  model: string;
  ok: boolean;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
}
/** 台账快照，给卡片/路由用。 */
interface UsageSnapshot {
  /** 统计口径说明（卡片直接展示，避免误读成账号总额度）。 */
  scope: 'local';
  day: string;
  totals: UsageTotals;
  today: UsageTotals;
  byAccount: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  recent: readonly UsageEvent[];
}
declare class DevecoUsageTracker {
  private readonly path;
  private document;
  private loaded;
  private flushTimer;
  constructor(options: {
    path: string;
  });
  /** 读盘。失败/文件缺失都不影响插件启动。 */
  load(): Promise<void>;
  /** 记一次请求。 */
  record(event: Omit<UsageEvent, 'at'> & {
    at?: number;
  }): void;
  /** 立刻落盘（插件停用时调）。 */
  flush(): Promise<void>;
  /** 当前快照。 */
  snapshot(): UsageSnapshot;
  private scheduleFlush;
  /** 跨天把 `today` 归零（`totals` 保留）。 */
  private rollDay;
}
interface DevecoShimOptions {
  store: DevecoAccountStore;
  pool: DevecoAccountPool;
  catalog: DevecoCatalog;
  usage: DevecoUsageTracker;
  /** 额度窗口状态：成功即「没被额度挡住」，被上游判额度用尽时留档。 */
  quota: DevecoQuotaTracker;
  /** 用户勾选的模型（空 = 全给）。 */
  enabledModels?: () => readonly string[] | undefined;
  /**
   * 某个账号的空闲槽位归零时的回调。
   *
   * 用途：后台续期本该给这个号换令牌、但当时它有请求在飞，于是挂成待办；请求一结束就靠这个
   * 回调立刻补刷一次，而不是等下一轮巡检（最坏 5 分钟）。
   */
  onAccountIdle?: (id: string) => void;
  logger?: {
    debug: (message: string) => void;
    warn: (message: string, ...rest: unknown[]) => void;
  };
}
/** shim 对外句柄。 */
interface DevecoShim {
  baseUrl(): string;
  token(): string;
  ready: Promise<void>;
  close(): Promise<void>;
  stats(): ShimStats;
}
/** 一条失败的滚动记录。 */
interface ShimFailure {
  at: number;
  account: string;
  status: number;
  kind: string;
  message: string;
}
/** 诊断快照。 */
interface ShimStats {
  port: number;
  lastAccount?: string;
  lastModel?: string;
  lastError?: string;
  lastStatus?: number;
  lastLatencyMs?: number;
  /**
   * 最近一次聊天请求**实际发出去**的 max_tokens（输出上限）。
   *
   * 排查「回答被截断」时这是第一现场：它和上下文窗口无关，是这个值太小才会在推理
   * 中途撞线。为 undefined 表示请求没带 max_tokens（上游按自己的默认走）。
   */
  lastMaxTokens?: number;
  /** 最近一次聊天请求里 `stream` 的取值。 */
  lastStream?: boolean;
  /**
   * 最近一次**流式响应中途**出现的鉴权错误原文。
   *
   * 这是排查「推理到一半提示密钥无效」的关键：它说明上游开了流之后才否认令牌，
   * 通常是令牌在长回合里过期，或被同账号的其它客户端/后台续期轮换掉了。
   */
  lastStreamAuthError?: string;
  /** 最近一次请求里，因 401 触发的重试次数（0–5）。 */
  lastAuthRetry?: number;
  /**
   * 最近的失败记录（最多 5 条，最新在前）。
   *
   * 只留最后一次的统计没法解释「几分钟前那次为什么失败」—— 后续成功的请求会把它覆盖掉。
   * 这份滚动记录让下一次出现问题时，一条 /doctor 就能看到真实原因。
   */
  recentFailures?: ShimFailure[];
}
declare function createDevecoShim(options: DevecoShimOptions): DevecoShim;
/** 这个 bundle 拥有的 provider 路由。与 `cordis.patch.yml` 保持一致。 */
declare const DEVECO_PROVIDER = "deveco";
interface DevecoAdapterOptions {
  shim: DevecoShim;
  catalog: DevecoCatalog;
  enabledModels?: () => readonly string[] | undefined;
  resolveAttachments?: () => AttachmentStore | undefined;
}
interface DevecoAdapter {
  adapter: PiAiAdapter;
  invalidate: () => void;
}
declare function createDevecoAdapter(options: DevecoAdapterOptions): DevecoAdapter;
/** 一个账号某一天的签到结果。 */
interface CheckinRecord {
  at: number;
  /** 凭证有效且能拉到模型目录。 */
  ok: boolean;
  /** 当天拉到的模型数（ok 时有意义）。 */
  models: number;
  /** 失败原因。 */
  message?: string;
}
/** 台账快照。 */
interface CheckinSnapshot {
  /** 今天（本地自然日）。 */
  day: string;
  /** 今天各账号的结果。 */
  today: Record<string, CheckinRecord>;
  /** 各账号连续签到天数（含今天）。 */
  streaks: Record<string, number>;
  /** 最近 30 天里有签到的日期（倒序）。 */
  days: string[];
}
/** 单账号签到结果，给路由/卡片用。 */
interface CheckinAccountResult extends CheckinRecord {
  id: string;
  /** 今天之前是否已经签过（幂等，重复点不再打上游）。 */
  alreadyCheckedToday: boolean;
}
/** 一次签到的汇总。 */
interface CheckinOutcome {
  day: string;
  results: CheckinAccountResult[];
  /** 至少一个账号签成功。 */
  ok: boolean;
  /** 本次真的打了上游的账号数。 */
  probed: number;
  message: string;
}
declare class DevecoCheckinLedger {
  private readonly path;
  private document;
  private loaded;
  constructor(options: {
    path: string;
  });
  private ensureLoaded;
  private prune;
  private flush;
  /** 某账号今天的记录。 */
  todayRecord(accountId: string, now?: number): CheckinRecord | undefined;
  /** 写入一条记录（同一天同账号覆盖）。 */
  record(accountId: string, record: CheckinRecord, now?: number): void;
  /**
   * 连续签到天数：从今天往回数，**只要当天有成功记录**就继续。
   *
   * 今天还没签时从昨天开始数（这样「今天还没签」不会把连续天数显示成 0）。
   */
  streak(accountId: string, now?: number): number;
  /** 台账快照。 */
  snapshot(accountIds: readonly string[], now?: number): CheckinSnapshot;
}
/**
 * 执行一次签到。
 *
 * - `accountId` 省略 = 所有账号；
 * - 今天已经签过（且成功）的账号默认跳过，不重复打上游（`force: true` 可强制重签）；
 * - 凭证被上游拒绝时把账号标成 stale —— 签到本来就是「这个号今天还能不能用」的体检，
 *   发现问题却不在卡片上体现，那这个功能就白做了。
 */
declare function runCheckin(store: DevecoAccountStore, ledger: DevecoCheckinLedger, options?: {
  accountId?: string;
  force?: boolean;
  signal?: AbortSignal;
}): Promise<CheckinOutcome>;
/** 一次跨账号发现的完整结果。 */
interface DiscoveryOutcome {
  models: readonly DevecoModelInfo[];
  /** 至少一个账号能给出目录。 */
  anySucceeded: boolean;
  accounts: {
    id: string;
    models: number;
    errors: string[];
  }[];
}
/**
 * 逐号发现并合并。
 *
 * 隐藏模型（`deepseek-v4-flash`）不在上游目录里，单独补在最后 —— 它的窗口和普通模型
 * 完全不同（1M），也不该被合并规则跟别的模型混在一起。
 */
declare function discoverModels(store: DevecoAccountStore, signal?: AbortSignal): Promise<DiscoveryOutcome>;
/** 拉一次目录并写进 `catalog`；失败时保留旧目录（上游抖动不该清空模型选择器）。 */
declare function refreshCatalog(store: DevecoAccountStore, catalog: DevecoCatalog, signal?: AbortSignal): Promise<DiscoveryOutcome>;
interface QueueSnapshot {
  /** 正在上游跑的数量。 */
  active: number;
  /** 在本地排队的数量。 */
  queued: number;
  /** 上限（诊断用）。 */
  maxConcurrent: number;
  maxQueue: number;
}
declare class DevecoQueueGate {
  private active;
  private readonly waiters;
  private readonly maxConcurrent;
  private readonly maxQueue;
  private readonly cooldownMs;
  private disposed;
  constructor(options?: {
    maxConcurrent?: number;
    maxQueue?: number;
    cooldownMs?: number;
  });
  /**
   * 申请一个生成位。
   *
   * @returns `true` = 拿到了，用完必须 `release()`；`false` = 队列已满（调用方回 429）。
   */
  acquire(signal?: AbortSignal): Promise<boolean>;
  /** 释放一个生成位，并让队首入场。 */
  release(): void;
  /** 队列里还有几个在等。 */
  queued(): number;
  snapshot(): QueueSnapshot;
  /** 撤掉所有等待者（插件停用）。 */
  dispose(): void;
  /** 有空位就把队首放进来（排队过的请求先冷却一小会儿）。 */
  private pump;
}
/** 登录失败的分类，卡片按它给不同的文案。 */
type LoginFailureKind = 'cancelled' | 'region' | 'timeout' | 'network' | 'exchange' | 'server';
/** 登录结果（成功/失败都以 result 的形式 resolve，不 reject）。 */
type LoginOutcome = {
  state: 'done';
  credential: DevecoCredential;
} | {
  state: 'error';
  kind: LoginFailureKind;
  message: string;
};
/** 启动登录后拿到的东西：地址、端口，以及最终结果的 promise。 */
interface StartedLogin {
  url: string;
  port: number;
  result: Promise<LoginOutcome>;
  /** 主动收摊（插件停用/用户取消时）。 */
  cancel: () => void;
}
/**
 * 起一次登录。
 *
 * 端口绑定是同步的一小步（毫秒级），先等它完成才拿得到真正要展示给用户的 URL。
 * 之后的等待都在 `result` 上，卡片可以轮询它，不必挂着一个长请求。
 */
declare function startLogin(options?: {
  openBrowser?: boolean;
}): Promise<StartedLogin>;
/** 构建时由 tsdown 注入的包版本；直接跑源码（测试/调试）时退化成 dev 标记。 */
declare const DEVECO_VERSION: string;
/** 稳定的 Cordis 插件名（与 `cordis.patch.yml` 的 id 对齐）。 */
declare const name = "llm-deveco";
/** provider 注册前必须先有 `llm` 服务。 */
declare const inject: string[];
/** 拥有配置卡片的 settings 命名空间。 */
declare const DEVECO_SETTINGS_NS: SettingsNamespace;
/** 插件配置。 */
interface Config {
  /** 模型选择器里允许出现的模型 id（空 = 全部）。 */
  enabledModels?: string[];
  /** 对话输入框下方的 `Provider DevEco · 模型 · 今日用量` 那一行。 */
  showDock?: boolean;
  /** 侧边栏图标列里的 DevEco 入口。缺省关：图标列是全宿主共用资源。 */
  showSidebarPanel?: boolean;
  /** 设置左侧导航里的 DevEco 入口。缺省开。 */
  showSettingsEntry?: boolean;
  /** 每天自动签到一次（逐个账号体检并留档）。缺省关。 */
  autoCheckin?: boolean;
  /** 同时打到上游的生成数（上游每个账号只放 1 个）。 */
  maxConcurrent?: number;
  /** 本地排队上限，超出直接 429。 */
  maxQueue?: number;
}
declare const Config: z<Config>;
/** 签到说明（卡片直接展示，别让用户以为这是「领积分」）。 */
declare const CHECKIN_NOTE: string;
declare function apply(ctx: Context, rawConfig: Config): void;
export { type AccountRuntime, CHECKIN_NOTE, type CheckinOutcome, type CheckinSnapshot, Config, DEVECO_PROVIDER, DEVECO_SETTINGS_NS, DEVECO_VERSION, DevecoAccountPool, DevecoAccountStore, type DevecoAccountSummary, type DevecoAdapter, DevecoCatalog, DevecoCheckinLedger, type DevecoCredential, type DevecoModelInfo, DevecoQueueGate, type DevecoShim, DevecoUsageTracker, type DiscoveryOutcome, FALLBACK_PARAMS, HIDDEN_MODELS, type LoginOutcome, type ShimStats, type StartedLogin, type UsageSnapshot, apply, createDevecoAdapter, createDevecoShim, devecoAccountsPath, devecoCheckinPath, devecoUsagePath, discoverModels, filterEnabledModels, inject, mergeModelLists, name, parseJwtPayload, refreshCatalog, runCheckin, startLogin };