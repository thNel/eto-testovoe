import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { measureDownload } from '../measure.mjs';

const cliPath = fileURLToPath(new URL('../speed-test.mjs', import.meta.url));

async function startServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

async function runCli(url) {
  const child = spawn(process.execPath, [cliPath], { timeout: 5_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${url}\n`);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('CLI полностью дочитывает каждый ответ перед следующим запросом', async (t) => {
  const events = [];
  const body = 'first\nsecond\n';
  const url = await startServer(t, async (request, response) => {
    if (events.length === 0) {
      events.push('probe');
      response.writeHead(200).flushHeaders();
      return;
    }
    events.push(request.method);
    response.write('first\n');
    // Пауза позволяет увидеть, начался ли следующий запрос до второй части тела.
    await delay(10);
    events.push('end');
    response.end('second\n');
  });

  const { code, stdout, stderr } = await runCli(url);

  assert.equal(code, 0, stderr);
  assert.deepEqual(events, ['probe', ...Array.from({ length: 10 }, () => ['GET', 'end']).flat()]);
  assert.match(stdout, new RegExp(`Общий объём скачанных данных: ${Buffer.byteLength(body) * 10} байт`));
  assert.match(stdout, /Скорость скачивания: [\d.]+ Мбит\/с/);
});

test('вывод редиректов завершается до замеров, результаты выводятся между ними', async (t) => {
  const events = [];
  let fileRequests = 0;
  const url = await startServer(t, (request, response) => {
    events.push(request.url);
    if (request.url === '/') {
      response.writeHead(301, { Location: '/file' }).end();
      return;
    }
    fileRequests += 1;
    if (fileRequests === 1) {
      response.writeHead(200).flushHeaders();
      return;
    }
    response.once('finish', () => events.push('file:finish'));
    response.end('data');
  });

  const result = await measureDownload(new URL(url), {
    async onRedirect() {
      events.push('redirect-log:start');
      await delay(10);
      events.push('redirect-log:end');
    },
    async onMeasurement({ number }) {
      if (number === 1) {
        events.push('result-log:start');
        await delay(10);
        events.push('result-log:end');
      }
    },
  });

  const attempt = ['/file', 'file:finish'];
  assert.deepEqual(events, [
    '/', '/file', 'redirect-log:start', 'redirect-log:end',
    ...attempt,
    'result-log:start', 'result-log:end',
    ...Array.from({ length: 9 }, () => attempt).flat(),
  ]);
  assert.equal(result.totalBytes, 40);
});

test('CLI сообщает о неполном ответе', async (t) => {
  let checked = false;
  const url = await startServer(t, async (_request, response) => {
    if (!checked) {
      checked = true;
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Length': 100 }).write('short');
    await delay(10);
    response.destroy();
  });

  const { code, stdout, stderr } = await runCli(url);

  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Запрос 1 из 10: Ответ получен не полностью\./);
});

test('CLI завершает замер с понятной ошибкой при смене протокола', async (t) => {
  let checked = false;
  const url = await startServer(t, (request, response) => {
    if (!checked) {
      checked = true;
      response.end();
      return;
    }
    // Оставляем сокет открытым, чтобы проверить, что после ответа 101 его закроет клиент.
    request.socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n',
    );
  });

  const { code, stdout, stderr } = await runCli(url);

  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Запрос 1 из 10: Сервер вернул HTTP 101/);
});
