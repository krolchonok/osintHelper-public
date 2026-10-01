const { ProxyAgent } = require("undici");
const { getHttpsProxySettings } = require("./provider-settings");

const hostProviders = new Map([
  ["api.intelx.io", "intelx"], ["intelx.io", "intelx"],
  ["tls.bufferover.run", "bufferover"],
  ["app.netlas.io", "netlas"], ["netlas.io", "netlas"],
  ["api.2ip.me", "2ip"], ["2ip.me", "2ip"],
  ["api.securitytrails.com", "securitytrails"], ["api.shodan.io", "shodan"],
  ["www.virustotal.com", "virustotal"], ["www.zoomeye.org", "zoomeye"],
  ["urlscan.io", "urlscan"], ["api.urlscan.io", "urlscan"],
  ["api.fullhunt.io", "fullhunt"], ["fullhunt.io", "fullhunt"], ["osint.bevigil.com", "bevigil"],
  ["www.reconeer.com", "reconeer"], ["api.threatbook.cn", "threatbook"],
  ["subdomains.whoisxmlapi.com", "whoisxmlapi"], ["api.zoomeye.ai", "zoomeye"],
  ["www.googleapis.com", "googlecse"], ["customsearch.googleapis.com", "googlecse"],
  ["searchapi.api.cloud.yandex.net", "yandexsearchapi"],
]);

let activeAgent = null;
let activeUrl = "";
let installed = false;

function providerForHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  for (const [domain, provider] of hostProviders) {
    if (host === domain || host.endsWith(`.${domain}`)) return provider;
  }
  return null;
}

function installHttpsProxyRouting() {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); }
    catch { return originalFetch(input, init); }
    const provider = providerForHost(url.hostname);
    if (url.protocol !== "https:" || !provider) return originalFetch(input, init);
    const settings = getHttpsProxySettings();
    if (!settings.url || !settings.providers.includes(provider)) return originalFetch(input, init);
    if (activeUrl !== settings.url) {
      activeAgent?.close().catch(() => {});
      activeAgent = new ProxyAgent(settings.url);
      activeUrl = settings.url;
    }
    return originalFetch(input, { ...init, dispatcher: activeAgent });
  };
}

module.exports = { installHttpsProxyRouting };
