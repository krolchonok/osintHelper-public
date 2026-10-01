const { ProxyAgent } = require("undici");
const { getHttpsProxySettings } = require("./provider-settings");

const hostProviders = new Map([
  ["index.commoncrawl.org", "commoncrawl"],
  ["web.archive.org", "waybackarchive"],
  ["cavalier.hudsonrock.com", "hudsonrock"],
  ["api.hackertarget.com", "hackertarget"],
  ["crt.sh", "crtsh"],
  ["www.google.com", "dork-google"],
  ["www.bing.com", "dork-bing"],
  ["html.duckduckgo.com", "dork-duckduckgo"],
  ["yandex.com", "dork-yandex"], ["yandex.ru", "dork-yandex"],
  ["www.googleapis.com", "dork-google-api"], ["customsearch.googleapis.com", "dork-google-api"],
  ["searchapi.api.cloud.yandex.net", "dork-yandex-api"],
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
  ["www.googleapis.com", ["dork-google-api", "googlecse"]],
  ["customsearch.googleapis.com", ["dork-google-api", "googlecse"]],
  ["searchapi.api.cloud.yandex.net", ["dork-yandex-api", "yandexsearchapi"]],
]);

let activeAgent = null;
let activeUrl = "";
let installed = false;

function providerForHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  for (const [domain, provider] of hostProviders) {
    if (host === domain || host.endsWith(`.${domain}`)) return Array.isArray(provider) ? provider : [provider];
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
    if (!settings.url || !provider.some((id) => settings.providers.includes(id))) return originalFetch(input, init);
    if (activeUrl !== settings.url) {
      activeAgent?.close().catch(() => {});
      activeAgent = new ProxyAgent(settings.url);
      activeUrl = settings.url;
    }
    return originalFetch(input, { ...init, dispatcher: activeAgent });
  };
}

module.exports = { installHttpsProxyRouting };
