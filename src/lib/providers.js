const providerCatalog = [
  {
    id: "bevigil",
    title: "BeVigil",
    description: "Mobile/web intelligence source for exposed assets.",
    helpLinks: [{ text: "BeVigil Console", url: "https://bevigil.com/" }],
  },
  {
    id: "bufferover",
    title: "BufferOver",
    description: "Certificate transparency and passive DNS aggregations.",
  },
  {
    id: "fullhunt",
    title: "FullHunt",
    description: "Attack surface and subdomain discovery API.",
    helpLinks: [{ text: "FullHunt API Key", url: "https://fullhunt.io/" }],
  },
  {
    id: "googlecse",
    title: "Google CSE",
    description: "Google Programmable Search JSON API (token format: API_KEY|CX).",
    helpLinks: [
      { text: "Создать Google API Key", url: "https://console.cloud.google.com/apis/api/customsearch.googleapis.com" },
      { text: "Создать Custom Search (CX)", url: "https://programmablesearchengine.google.com/controlpanel/all" },
    ],
  },
  {
    id: "intelx",
    title: "IntelX",
    description: "IntelX leak search API (supports one or multiple keys separated by commas).",
    helpLinks: [{ text: "IntelX Developer Console", url: "https://intelx.io/" }],
  },
  {
    id: "netlas",
    title: "Netlas",
    description: "Netlas DNS Search API for subdomain discovery.",
    helpLinks: [{ text: "Netlas API Key", url: "https://netlas.io/" }],
  },
  {
    id: "reconeer",
    title: "Reconeer",
    description: "OSINT recon API provider.",
  },
  {
    id: "securitytrails",
    title: "SecurityTrails",
    description: "DNS history and domain intelligence API.",
    helpLinks: [{ text: "SecurityTrails Console", url: "https://securitytrails.com/" }],
  },
  {
    id: "shodan",
    title: "Shodan",
    description: "Internet-wide host search platform.",
    helpLinks: [{ text: "Shodan Account Key", url: "https://account.shodan.io/" }],
  },
  {
    id: "threatbook",
    title: "ThreatBook",
    description: "Threat intel and DNS data provider.",
    helpLinks: [{ text: "ThreatBook API Key", url: "https://threatbook.io/" }],
  },
  {
    id: "urlscan",
    title: "urlscan",
    description: "Web scan archive and host extraction.",
    helpLinks: [{ text: "urlscan.io API Keys", url: "https://urlscan.io/user/" }],
  },
  {
    id: "virustotal",
    title: "VirusTotal",
    description: "Domain and relationship intelligence API.",
    helpLinks: [{ text: "VirusTotal API Key", url: "https://www.virustotal.com/gui/my-apikey" }],
  },
  {
    id: "whoisxmlapi",
    title: "WhoisXMLAPI",
    description: "Domain and subdomain intelligence API.",
    helpLinks: [{ text: "WhoisXMLAPI Console", url: "https://whoisxmlapi.com/" }],
  },
  {
    id: "yandexsearchapi",
    title: "Yandex Search API",
    description: "Yandex Search API v2 (token format: API_KEY|FOLDER_ID).",
    helpLinks: [
      { text: "Яндекс Облако Консоль", url: "https://console.cloud.yandex.ru/" },
      { text: "Yandex Search API Документация", url: "https://yandex.ru/dev/xml/" },
    ],
  },
];

const providerMap = new Map(providerCatalog.map((item) => [item.id, item]));

module.exports = {
  providerCatalog,
  providerMap,
};
