import { createInterface } from 'node:readline';
import { measureDownload } from './measure.mjs';

const args = process.argv.slice(2);
const usage = 'Запуск: node speed-test.mjs (URL читается из stdin)';
const invalidUrl = 'Укажите полный адрес с http:// или https://.';

async function readUrl() {
  const interactive = process.stdin.isTTY;
  const input = createInterface({
    input: process.stdin,
    output: interactive ? process.stderr : undefined,
    crlfDelay: Infinity,
  });

  if (interactive) {
    input.setPrompt('Введите URL: ');
    input.prompt();
  }

  try {
    for await (const line of input) {
      const address = line.trim();
      // URL.parse допускает форму https:example.com. CLI требует префикс со слешами.
      const url = /^https?:\/\//i.test(address) ? URL.parse(address) : null;
      if (url) return url;

      // В конвейере первая строка считается единственным входным адресом.
      if (!interactive) throw new Error(invalidUrl);
      console.error(invalidUrl);
      input.prompt();
    }
    throw new Error('Передайте URL во входном потоке (stdin).');
  } finally {
    input.close();
  }
}

// Промежуточные логи идут в stderr, чтобы stdout содержал только итоговую сводку.
function writeLog(line) {
  return new Promise((resolve, reject) => {
    process.stderr.write(`${line}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function logMeasurement({ number, total, bytes, durationMs }) {
  const prefix = `Запрос ${number} из ${total}`;
  return writeLog(`${prefix}: скачано ${bytes} байт за ${durationMs.toFixed(2)} мс.`);
}

function logRedirect({ status, url }) {
  // В параметрах ссылки могут быть токены. Для сообщения достаточно адреса и пути.
  return writeLog(`Переадресация HTTP ${status} → ${url.origin}${url.pathname}`);
}

if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log(usage);
} else if (args.length > 0) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const url = await readUrl();
    const { averageMs, totalBytes, speedMbps } = await measureDownload(url, {
      onMeasurement: logMeasurement,
      onRedirect: logRedirect,
    });
    console.log();
    console.log(`Среднее время запроса: ${averageMs.toFixed(2)} мс`);
    console.log(`Общий объём скачанных данных: ${totalBytes} байт`);
    console.log(`Скорость скачивания: ${speedMbps.toFixed(2)} Мбит/с`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
