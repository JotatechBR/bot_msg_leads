# Órbita · Seu espaço de prospecção

Interface local para o bot de leads do Google Maps e WhatsApp. O painel usa HTML, CSS e JavaScript nativos e um servidor Node.js, sem novas dependências de produção.

## Abrir o painel

É necessário Node.js 20.12 ou superior.

```bash
npm start
```

Acesse **http://localhost:3001** no navegador. Para desenvolvimento, `npm run dev` reinicia o servidor quando os arquivos mudam. Recarregue o navegador após editar a interface. Se a porta estiver ocupada, use `PORT=3002 npm start`.

## Publicar o painel na Vercel

O arquivo `vercel.json` publica a pasta `web/`, que contém `index.html`, e encaminha `/api/*` para `api/proxy.js`. A Vercel hospeda o painel; o motor das campanhas e as sessões do WhatsApp continuam em um servidor Node persistente no Ubuntu ou em uma VPS.

1. Mantenha o servidor do bot acessível por HTTPS. No Ubuntu, use `npm run publico` e copie o **LINK PÚBLICO** mostrado no terminal.
2. Na Vercel, use a raiz deste repositório como **Root Directory** e **Other** como **Framework Preset**. O `vercel.json` define a pasta de saída como `web`, sem instalação nem comando de build.
3. Em **Settings → Environment Variables**, configure `ORBITA_BACKEND_URL` com a origem HTTPS do bot, por exemplo `https://nome-do-tunel.trycloudflare.com`, sem `/api` no final.
4. Publique novamente. O painel usa o mesmo domínio da Vercel para suas chamadas e o proxy as encaminha ao servidor do bot.

Sem `ORBITA_BACKEND_URL`, o painel informa a configuração pendente. A chave do Google e as sessões permanecem no servidor do bot. Se usar um túnel temporário, atualize essa variável e publique novamente quando o link mudar.

## Acessar de qualquer rede, sem usuário e senha

Encerre a execução anterior com **Ctrl+C** e rode no terminal do projeto:

```bash
npm run publico
```

Na primeira execução, o comando baixa o `cloudflared` do repositório oficial da Cloudflare, verifica o SHA-256 informado pelo GitHub e salva o executável em `.orbita/bin/`. Nas próximas execuções, reutiliza o arquivo verificado. Não é necessário instalar pacotes com `sudo`.

O comando inicia o servidor e abre um túnel HTTPS. O terminal mostra **LINK PÚBLICO** com um endereço no formato `https://nome-aleatorio.trycloudflare.com`. Compartilhe esse link: qualquer pessoa, de qualquer rede, pode abrir o painel sem fazer login. Acesso às campanhas, contas, mensagens, histórico e logs também fica disponível pelo link.

Mantenha esse terminal e o Ubuntu ligados e conectados à internet. **Ctrl+C** encerra o túnel e o servidor. O endereço é temporário e muda ao iniciar outro túnel; não é necessário abrir a porta do roteador. Esse comportamento é o dos [Quick Tunnels da Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Status, QR code, contadores e logs são atualizados a cada dois segundos no acesso público, porque Quick Tunnels não suportam SSE. No acesso local, a conexão de eventos em tempo real continua disponível.

Se você já possui o `cloudflared` instalado, pode indicar seu executável:

```bash
CLOUDFLARED_BIN=/usr/local/bin/cloudflared npm run publico
```

Para usar outra porta local:

```bash
PORT=3002 npm run publico
```

O servidor do modo público escuta em `127.0.0.1`, e o túnel faz a ponte com a internet. Executar apenas `node server.js --publico` prepara o servidor para um túnel ou proxy HTTPS; esse comando sozinho não cria um link público.

## Acessar somente pela rede local no Ubuntu

```bash
npm run rede
```

Esse comando escuta em `0.0.0.0` e permite o uso do painel por outros dispositivos da rede privada, sem usuário e senha. O endereço de rede aparece no terminal. Na configuração atual deste Ubuntu:

```text
http://192.168.15.104:3001
```

Se o UFW estiver ativo e bloquear a porta, execute no terminal do Ubuntu:

```bash
sudo ufw allow from 192.168.15.0/24 to any port 3001 proto tcp
sudo ufw status
```

A regra libera a porta somente para essa faixa de rede. Se mudar a porta com `PORT`, ajuste também a regra. Se mudar de rede, use o novo IP e a nova faixa; `hostname -I` mostra os endereços do computador. Essa regra não é necessária para o túnel do comando `npm run publico`.

Você pode definir `ORBITA_REDE=1` no `.env` para habilitar o modo de rede local com `npm start`. As opções antigas `ORBITA_USUARIO`, `ORBITA_SENHA` e o arquivo `.orbita/acesso-rede.json` deixaram de ser usados.

## Como funciona

- **Visão geral:** indicadores reais, oportunidades na fila, últimos contatos, envios por período e distribuição por segmento. Atualiza a cada 30 segundos quando a tela está visível e sem um controle em foco.
- **Explorar leads:** busca por empresa, telefone, nicho ou cidade; filtros por status, nicho e região; ordenação, paginação, detalhes e exportação CSV com seleção entre páginas. O atalho `/` abre a busca.
- **Campanhas:** prepara nichos, cidades e quantidade de contas. Os botões **Iniciar campanha** e **Parar campanha** controlam a execução no servidor. O painel mostra os contadores e a atividade em tempo real.
- **Mensagens:** edita `mensagem.txt`, insere as variáveis reconhecidas pelo bot e mostra a prévia por empresa e por versão. As versões continuam separadas por uma linha `---`.
- **Contas WhatsApp:** conecta até cinco contas pelo QR code exibido no painel. Permite reconectar uma sessão salva, cancelar o pareamento, desconectar e gerar um novo QR quando o login for encerrado.
- **Configurações:** mostra a presença da chave do Google e permite desativar animações. A preferência de movimento reduzido do sistema também é respeitada.

A interface lê `historico.json`; o motor da campanha atualiza esse arquivo durante as buscas e os envios, com gravação atômica. Empresas e telefones já contatados são retirados da lista de oportunidades disponíveis. Registros antigos sem nicho, conta ou avaliação mostram a informação como ausente.

## Conectar e iniciar uma campanha

1. Inicie o servidor com `npm start` e mantenha esse terminal aberto.
2. Abra **Contas WhatsApp** e clique em **Conectar WhatsApp** ou **Reconectar WhatsApp**.
3. No celular, abra **WhatsApp → Aparelhos conectados → Conectar um aparelho** e escaneie o QR mostrado no painel. Aguarde **Conectado**. Sessões ainda válidas podem reconectar sem pedir QR.
4. Salve os textos na aba **Mensagens**.
5. Prepare sua campanha com os nichos, cidades e quantidade de contas.
6. Na lista de campanhas, clique em **Iniciar campanha**. A execução faz consultas à API do Google e envia as mensagens salvas usando as primeiras contas conectadas, em ordem de identificador.
7. Use **Parar campanha** para interromper. Operações de envio já iniciadas são finalizadas antes de o status mudar para **Parada**.

Salvar um rascunho e conectar uma conta não iniciam envios. O clique em **Iniciar campanha** inicia a execução real; as consultas ao Google podem gerar cobrança. Só uma campanha executa por vez. Para usar duas contas, conecte dois números diferentes antes de iniciar.

O servidor permanece responsável pela execução mesmo ao navegar entre telas ou fechar a aba. Encerrar o servidor encerra a campanha e as conexões; elas não reiniciam automaticamente. Os modelos de mensagem são carregados no início de cada campanha.

O comando `npm run dev` reinicia o servidor quando os arquivos mudam; use `npm start` durante campanhas reais para evitar reinícios por edição de arquivos.

## Logs no terminal e em arquivo

O terminal em que você executa `npm start` recebe os eventos com data, horário de São Paulo, nível e identificação da conta ou campanha:

```text
18/10, 20:15:30  INFO     [Campanha Campinas]  Buscando barbearia em Campinas SP.
18/10, 20:15:35  SUCCESS  [WA1]  Empresa Exemplo · barbearia · +5519999999999 · mensagem enviada. Total: 1.
```

Os eventos incluem conexões, atualização de QR, buscas, consultas à API, envios, números sem WhatsApp, erros, pausas entre rodadas e resumo da execução. O QR e as chaves de autenticação não são escritos nos logs.

O painel de Campanhas mostra a atividade recente. O histórico completo é salvo em **`.orbita/logs/AAAA-MM-DD.log`**, separado por dia. Para acompanhar o arquivo em outro terminal, substitua a data abaixo:

```bash
tail -f .orbita/logs/2026-10-18.log
```

Rascunhos ficam em `.orbita/campanhas.json`; resumos de execução, em `.orbita/execucoes.json`. Ao refazer o pareamento, a sessão anterior é arquivada em `.orbita/sessoes-anteriores/`.

A execução antiga pelo terminal continua disponível:

```bash
# Prévia: consulta o Google sem conectar nem enviar
node enviar.js 'barbearia, pet shop' 'Campinas SP' --contas 1 --teste
```

O painel e a execução de envios pelo terminal compartilham um bloqueio em `.orbita/runtime.lock`. Depois de conectar pelo painel, encerre o servidor antes de executar envios pela CLI, para evitar que dois processos usem as mesmas sessões e o mesmo histórico.

## Interface e arquivos

O visual combina verde floresta `#203E35`, marfim `#F5F6F1` e sálvia `#D7E7AD`. O espaçamento usa uma escala de 4 px, com agrupamentos compactos e separações maiores entre áreas. A fonte Ubuntu Sans é servida localmente; a licença está em `web/assets/FONT-LICENSE.txt`.

`web/index.html` define a estrutura; `web/styles.css` contém os tokens e estilos; `web/components.js`, `web/views.js` e `web/runtime-views.js` renderizam a interface; `web/app.js` coordena as interações e os eventos em tempo real. `server.js` serve a API, enquanto `bot/runtime.js`, `bot/whatsapp.js`, `bot/campaign.js`, `bot/logger.js` e `bot/storage.js` gerenciam conexões, campanhas, logs e persistência.

As animações usam entradas breves, feedback de clique e uma abertura com órbitas. Não há carregamento de fontes, imagens ou scripts de terceiros.

No modo padrão, o servidor aceita somente conexões do próprio computador. `npm run rede` permite a rede privada, e `npm run publico` permite visitantes de qualquer rede pelo túnel HTTPS. Os dois modos funcionam sem login. A validação de origem e a lista explícita de arquivos públicos permanecem ativas. Chaves do Google e arquivos de credenciais do WhatsApp não são enviados ao navegador; o QR temporário é exibido somente para o pareamento.

## Validação

A validação das mudanças de conexão, execução, logs e acessos local e público será feita por você, conforme solicitado. Não foram executados testes dessas alterações.
