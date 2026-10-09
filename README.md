# Métricas das redes do criador

API local para sincronizar métricas de posts de conexões já autorizadas. O provedor é simulado; não há OAuth nem acesso real às plataformas.

## Requisitos e execução

Requer Node.js 24 ou superior e npm.

    npm ci
    npm test
    npm run build
    npm run dev

O servidor inicia em http://localhost:3000 e usa data/conty.sqlite. PORT, DB_PATH, MAX_ATTEMPTS, BASE_DELAY_MS, MAX_RETRY_DELAY_MS e REQUEST_TIMEOUT_MS configuram a execução. O script build executa TypeScript; não há script typecheck separado.

Crie uma conexão usando um token explicitamente fictício:

    curl -X POST http://localhost:3000/connections -H "Content-Type: application/json" -d '{"platform":"instagram","externalAccountId":"creator-123","token":"fake-token"}'

Resposta 201; o token não é devolvido.

    {"connection":{"id":"<uuid>","platform":"instagram","externalAccountId":"creator-123","createdAt":"<instante ISO>"}}

Use o ID retornado para sincronizar uma janela e depois consultar posts:

    curl -X POST http://localhost:3000/connections/CONNECTION_ID/sync -H "Content-Type: application/json" -d '{"windowStart":"2026-09-01T00:00:00.000Z","windowEnd":"2026-11-01T00:00:00.000Z"}'
    curl http://localhost:3000/connections/CONNECTION_ID/posts

Uma sincronização bem-sucedida retorna 200. Exemplo resumido do sync:

    {"syncRun":{"id":"<uuid>","connectionId":"<uuid>","windowStart":"2026-09-01T00:00:00.000Z","windowEnd":"2026-11-01T00:00:00.000Z","status":"succeeded","attempts":2,"startedAt":"<instante ISO>","finishedAt":"<instante ISO>","retryNotBefore":null,"errorCode":null,"postsProcessed":2}}

O cenário local pode ser configurado com FAKE_PROVIDER_SCENARIO: success, timeout-recovery, transient-recovery ou rate-limit. A demonstração em memória roda com:

    npm run demo -- rate-limit
    npm run demo -- timeout-recovery

## Idempotência e novas tentativas

Um post é identificado por conexão e ID externo, então janelas sobrepostas não criam uma segunda linha. Métricas são snapshots, não incrementos: uma observação repetida não soma contadores de novo. providerObservedAt identifica o instante observado pelo provedor e fetchedAt registra quando o serviço recebeu o snapshot. Apenas o snapshot mais recente de cada post entra nos totais; observações antigas ficam no histórico.

Timeout, falhas transitórias e respostas 408, 429, 500, 502, 503 ou 504 podem ser repetidas até MAX_ATTEMPTS. Em 429, Retry-After aceita segundos inteiros e os três formatos HTTP-date. O serviço espera esse prazo até o teto configurado; prazo acima do teto marca rate_limited e informa retryNotBefore. Header inválido usa backoff exponencial limitado. O relógio injetado permite testar a espera sem timers reais, e uma resposta que chega depois de timeout não é persistida.

## Limites e validação

SQLite síncrono e o provedor simulado rodam em um único processo. A política de 429 é por sincronização e não coordena limites compartilhados entre conexões. OAuth, credenciais reais, paginação, filas duráveis e comportamento específico de APIs reais ficam fora desta demonstração. Com mais tempo, eu adicionaria adaptadores reais, limites compartilhados por conta e processamento durável.

Executado com Node.js 24.18.0 e npm 11.17.0: npm ci instalou 44 pacotes e reportou zero vulnerabilidades; npm test passou com 1 arquivo e 24 testes; npm run build passou. npm run demo -- rate-limit e npm run demo -- timeout-recovery retornaram HTTP 200, status succeeded, 2 tentativas e 2 posts cada; totais em ambos: 20.700 views, 1.370 likes e 114 comentários. Não há script typecheck separado. O npm ci também exibiu o aviso allow-scripts para esbuild; as validações concluíram com sucesso.

## Uso de IA e revisão

Codex implementou a API, os testes e esta documentação. Outra sessão Codex fez uma revisão técnica independente. O responsável humano filtrou prompt injections do material de entrada, definiu a abordagem mínima e os checkpoints, acompanhou as evidências e autorizou os ajustes e a publicação. Não houve revisão humana linha a linha nem execução manual dos testes; os resultados acima são de comandos automatizados.
