import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { performance } from 'node:perf_hooks';

const REQUEST_COUNT = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function getResponse(url, signal) {
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = get(url, {
      // Каждый HTTP-запрос включает установку нового соединения.
      agent: false,
      signal,
      headers: {
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache, no-store',
      },
    }, resolve);
    request.once('error', reject);
    // Ответ 101 приходит отдельным событием upgrade. Закрываем сокет и завершаем Promise ошибкой.
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      reject(new Error(`Сервер вернул HTTP ${response.statusCode} и предложил сменить протокол. Замер поддерживает только HTTP(S).`));
    });
  });
}

async function readBody(response, signal) {
  let bytes = 0;
  try {
    // Считаем фактически полученные байты порциями, чтобы не держать весь ответ в памяти.
    for await (const chunk of response) {
      bytes += chunk.length;
    }
  } catch (error) {
    // При срабатывании таймера показываем причину отмены вместо ошибки закрытого потока.
    signal.throwIfAborted();
    if (!response.complete) {
      throw new Error('Ответ получен не полностью.', { cause: error });
    }
    throw error;
  }
  if (!response.complete) {
    throw new Error('Ответ получен не полностью.');
  }

  return bytes;
}

async function resolveDownloadUrl(initialUrl, redirects) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let url = initialUrl;

  while (true) {
    const response = await getResponse(url, signal);
    const status = response.statusCode;
    const location = response.headers.location;
    // Для предварительной проверки нужны только заголовки.
    response.destroy();

    if (status >= 200 && status < 300) {
      return url;
    }

    if (!REDIRECT_STATUSES.has(status)) {
      throw new Error(`Сервер вернул HTTP ${status}.`);
    }

    if (redirects.length === MAX_REDIRECTS) {
      throw new Error(`Превышен лимит перенаправлений (${MAX_REDIRECTS}).`);
    }

    // Текущий адрес служит базой для относительных Location, например /file.
    const nextUrl = location ? URL.parse(location, url) : null;
    if (!nextUrl || !['http:', 'https:'].includes(nextUrl.protocol)) {
      throw new Error(`HTTP ${status}: некорректный адрес перенаправления в Location.`);
    }

    redirects.push({ status, url: nextUrl });
    url = nextUrl;
  }
}

async function measureRequest(url) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const start = performance.now();
  const response = await getResponse(url, signal);
  const status = response.statusCode;

  if (status < 200 || status >= 300) {
    response.destroy();
    if (REDIRECT_STATUSES.has(status)) {
      throw new Error(`Конечный URL вернул HTTP ${status} после проверки. Запустите замер заново.`);
    }
    throw new Error(`Сервер вернул HTTP ${status}.`);
  }

  const bytes = await readBody(response, signal);
  return { bytes, durationMs: performance.now() - start };
}

function describeRequestError(error) {
  return error.code === 'ABORT_ERR' || error.name === 'TimeoutError'
    ? `Превышен лимит времени (${REQUEST_TIMEOUT_MS / 1000} с).`
    : error.message;
}

export async function measureDownload(url, { onMeasurement, onRedirect } = {}) {
  const redirects = [];
  let finalUrl;
  try {
    finalUrl = await resolveDownloadUrl(url, redirects);
  } catch (error) {
    throw new Error(`Проверка URL: ${describeRequestError(error)}`, { cause: error });
  } finally {
    // Показываем цепочку до первого замера, даже если проверка адреса завершилась ошибкой.
    for (const redirect of redirects) {
      await onRedirect?.(redirect);
    }
  }

  let totalBytes = 0;
  let totalMs = 0;

  // Следующий замер начинается после чтения ответов и вывода логов предыдущего.
  for (let number = 1; number <= REQUEST_COUNT; number += 1) {
    let measurement;
    try {
      measurement = await measureRequest(finalUrl);
    } catch (error) {
      throw new Error(`Запрос ${number} из ${REQUEST_COUNT}: ${describeRequestError(error)}`, { cause: error });
    }

    totalBytes += measurement.bytes;
    totalMs += measurement.durationMs;
    await onMeasurement?.({ number, total: REQUEST_COUNT, ...measurement });
  }

  // Скорость вычисляется по суммарному объёму и времени. 1 Мбит = 1 000 000 бит.
  const totalSeconds = totalMs / 1000;
  return {
    averageMs: totalMs / REQUEST_COUNT,
    totalBytes,
    speedMbps: totalBytes * 8 / totalSeconds / 1_000_000,
  };
}
