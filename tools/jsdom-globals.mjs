/* 在 jsdom 的 window 上下文中补齐 Node 提供的全局能力 */
import { NodeEventSource } from './node-eventsource.mjs';

export function installGlobals(window) {
  window.EventSource = NodeEventSource;
  window.fetch = (...args) => globalThis.fetch(...args);
  window.Headers = globalThis.Headers;
  window.Request = globalThis.Request;
  window.Response = globalThis.Response;
  window.setTimeout = globalThis.setTimeout;
  window.clearTimeout = globalThis.clearTimeout;
  window.setInterval = globalThis.setInterval;
  window.clearInterval = globalThis.clearInterval;
  window.requestAnimationFrame = (cb) => globalThis.setTimeout(() => cb(0), 16);
  window.cancelAnimationFrame = (id) => globalThis.clearTimeout(id);
  window.console = globalThis.console;
  // jsdom 未实现 matchMedia：补一个默认不匹配的实现
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    });
  }
}
