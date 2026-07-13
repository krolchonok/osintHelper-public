const { getDbState } = require("../db");
const { nowIso } = require("./utils");
const crypto = require("crypto");

async function executeReverseIpTask(projectId, onProgress) {
  const { db } = getDbState();
  const emit = async (progress, stage) => {
    if (onProgress) {
      await onProgress({ progress, stage, processed: 0, total: 0 });
    }
  };

  await emit(5, "Поиск уникальных IP-адресов...");
  
  // Получаем все уникальные resolved IP из dns_records для проекта
  const ipRows = db
    .prepare(`
      SELECT DISTINCT value AS ip
      FROM dns_records
      WHERE project_id = ? AND record_type IN ('A', 'AAAA')
    `)
    .all(projectId);

  const ips = ipRows.map(row => row.ip).filter(ip => {
    return ip && (ip.includes(".") || ip.includes(":"));
  });

  if (!ips.length) {
    await emit(100, "Нет разрешенных IP-адресов для сканирования");
    return { ok: true, scannedCount: 0 };
  }

  const total = ips.length;
  let processed = 0;

  for (const ip of ips) {
    processed++;
    const progress = Math.min(95, Math.round(5 + (processed / total) * 90));
    await emit(progress, `Запрос HackerTarget для IP ${ip} (${processed}/${total})...`);

    try {
      const response = await fetch(`https://api.hackertarget.com/reverseiplookup/?q=${encodeURIComponent(ip)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const text = await response.text();
      
      if (text.includes("API count exceeded")) {
        console.warn("[reverse-ip] HackerTarget API limit exceeded");
        await emit(progress, `Лимит API HackerTarget исчерпан. Сканирование приостановлено.`);
        break;
      }

      let domains = [];
      if (!text.includes("No records found") && !text.includes("error")) {
        domains = text
          .split("\n")
          .map(line => line.trim())
          .filter(line => line && !line.includes(" ") && line.includes("."));
      }

      // Сохраняем в БД
      const now = nowIso();
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO project_reverse_ip (id, project_id, ip, domains_json, count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, ip)
        DO UPDATE SET
          domains_json = excluded.domains_json,
          count = excluded.count,
          updated_at = excluded.updated_at
      `).run(
        id,
        projectId,
        ip,
        JSON.stringify(domains),
        domains.length,
        now,
        now
      );

      // Задержка между запросами 1.5 секунды
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (err) {
      console.error(`[reverse-ip] error scanning ${ip}:`, err.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  await emit(100, "Сканирование IP-адресов завершено");
  return { ok: true, scannedCount: processed };
}

module.exports = {
  executeReverseIpTask,
};
