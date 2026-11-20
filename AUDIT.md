# Аудит web-клиента

На GitHub в `riskprofitLLC/chat-clients-web.git` (ветка `main`) уходит ТОЛЬКО
очищенный аудит-снапшот. Снапшот хранится отдельно в папке `audit/` рядом со
скриптом: `push-audit.sh` синхронизирует её по списку `audit-manifest.txt`
(рабочее дерево → `audit/`) и пушит single-коммитом force-push'ем.

В снапшот входят только файлы нашей разработки:

- `src/` — весь исходный код клиента (TypeScript, vanilla DOM, WebCrypto):
  протокол (`protocol/`), крипта (`crypto/`), домен (`domain/`), хранилища
  (`store/`), сеть (`net/`), UI (`ui/` + `i18n/`), медиа, PWA;
- `test/` — тесты (vitest, dev-зависимость);
- `public/` — манифест PWA, service worker, иконки (генерируются `scripts/make-icons.mjs`);
- `scripts/` — генератор иконок и постобработка service worker (`make-sw.mjs`);
- корневые конфиги (`package.json`, **`package-lock.json`** — для воспроизводимой
  сборки через `npm ci`, `tsconfig.json`, `vite.config.ts`), `index.html`, `README.md`.

Не входят: `node_modules/`, `dist/` (сборка), `promts/` (рабочие промпты),
временные файлы. Прод-зависимостей у клиента нет вообще —
dev-зависимости только `typescript`/`vite`/`vitest`.

Скрипт сверяет манифест с рабочим деревом: новый файл исходников без строки
в `audit-manifest.txt` остановит пуш с подсказкой, что дописать.

Рабочее дерево проекта на GitHub не публикуется никогда.
