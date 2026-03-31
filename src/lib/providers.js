const providerCatalog = [
  { id: "bevigil", title: "BeVigil", description: "Mobile/web intelligence source for exposed assets." },
  { id: "bufferover", title: "BufferOver", description: "Certificate transparency and passive DNS aggregations." },
  { id: "fullhunt", title: "FullHunt", description: "Attack surface and subdomain discovery API." },
  { id: "googlecse", title: "Google CSE", description: "Google Programmable Search JSON API (token format: API_KEY|CX)." },
  { id: "reconeer", title: "Reconeer", description: "OSINT recon API provider." },
  { id: "securitytrails", title: "SecurityTrails", description: "DNS history and domain intelligence API." },
  { id: "shodan", title: "Shodan", description: "Internet-wide host search platform." },
  { id: "threatbook", title: "ThreatBook", description: "Threat intel and DNS data provider." },
  { id: "urlscan", title: "urlscan", description: "Web scan archive and host extraction." },
  { id: "virustotal", title: "VirusTotal", description: "Domain and relationship intelligence API." },
  { id: "whoisxmlapi", title: "WhoisXMLAPI", description: "Domain and subdomain intelligence API." },
  { id: "yandexsearchapi", title: "Yandex Search API", description: "Yandex Search API v2 (token format: API_KEY|FOLDER_ID)." },
];

const providerMap = new Map(providerCatalog.map((item) => [item.id, item]));

module.exports = {
  providerCatalog,
  providerMap,
};
