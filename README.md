# Órbita · Seu espaço de prospecção

Painel para o bot de leads do Google Maps e WhatsApp. Use `npm start` para executar localmente, ou publique o painel na Vercel com o motor rodando 24h numa VPS da AWS.

## Abrir o painel

É necessário Node.js 20.12 ou superior.

```bash
npm start
```

Acesse **http://localhost:3001** no navegador. O projeto inicia somente em localhost, sem opções de acesso pela rede. Para desenvolvimento, `npm run dev` reinicia o servidor quando os arquivos mudam. Recarregue o navegador após editar a interface. Se a porta estiver ocupada, use `PORT=3002 npm start`.

## Publicar online: Vercel + VPS da AWS

O WhatsApp precisa de uma conexão aberta o tempo todo e de sessões salvas em disco. As funções da Vercel duram poucos segundos por requisição, por isso o projeto é dividido em dois:

```text
Navegador ──► Vercel (painel: web/) ──/api/*──► VPS AWS: Caddy (HTTPS) ──► server.js (WhatsApp, campanhas, histórico)
```

- **Vercel** serve só a interface e repassa `/api/*` para a VPS (rewrite em `vercel.json`). Para o navegador é um site só, sem CORS.
- **VPS** roda `server.js` 24h como serviço (`orbita`), atrás do Caddy, que emite o certificado HTTPS sozinho. O endereço usa `IP.sslip.io`, sem precisar comprar domínio.
- **Login:** no modo servidor o painel exige a senha `PAINEL_SENHA`. Sem ela o servidor não inicia. Após 10 senhas erradas em 15 minutos, o login fica bloqueado por 15 minutos.

### 1. Criar a VPS (AWS Lightsail)

1. No [Lightsail](https://lightsail.aws.amazon.com/), crie uma instância **Linux/Unix → OS Only → Ubuntu 24.04 LTS**, com pelo menos **1 GB de RAM**.
2. Em **Networking**: crie um **IP estático** e anexe à instância (o endereço HTTPS depende do IP). Na seção **IPv4 Firewall**, mantenha **HTTP (80)** e adicione **HTTPS (443)**.

> Se preferir EC2: Ubuntu 24.04, *security group* com entrada nas portas 22, 80 e 443, e um *Elastic IP* associado.

### 2. Instalar

Conecte por SSH (no Lightsail, botão **Connect using SSH**) e rode:

```bash
git clone https://github.com/JotatechBR/bot_msg_leads.git orbita
cd orbita
bash deploy/instalar-vps.sh
```

Se o repositório for privado, o `git clone` pede usuário e senha: use seu usuário do GitHub e, como senha, um [token de acesso](https://github.com/settings/tokens) com permissão de leitura do repositório.

O script instala Node.js 24 e Caddy, pede a chave do Google, cria a senha do painel e o endereço da Vercel (vão para o `.env` da VPS), configura o HTTPS e deixa o serviço `orbita` rodando e iniciando sozinho com a máquina. No final ele mostra o endereço `https://…sslip.io`.

### 3. Apontar a Vercel para a VPS

No `vercel.json`, troque `COLOQUE-O-IP-DA-VPS.sslip.io` pelo endereço mostrado no final da instalação, faça commit e push. A Vercel publica `web/` e repassa `/api/*` para a VPS.

### 4. Usar

Abra o endereço da Vercel, entre com a senha, vá em **Contas WhatsApp → Conectar WhatsApp**, escaneie o QR e inicie a campanha em **Campanhas**. A campanha continua rodando na VPS mesmo com o navegador fechado.

### Manutenção

| O quê | Comando na VPS |
| --- | --- |
| Logs ao vivo | `journalctl -u orbita -f` |
| Reiniciar | `sudo systemctl restart orbita` |
| Atualizar com o GitHub | `bash deploy/atualizar.sh` |
| Trocar a senha | edite `PAINEL_SENHA` no `.env` e reinicie (todos os logins abertos são encerrados) |

`deploy/atualizar.sh` para o serviço (interrompe a campanha em andamento), guarda `.env`, `historico.json`, `mensagem.txt`, `.orbita/` e `sessoes/` numa pasta de backup ao lado do projeto, baixa o código novo e restaura esses dados. **Os dados da VPS são os que valem**: o histórico de contatos dela não é sobrescrito pelo do GitHub.

**Importante:** depois de ativar a VPS, não rode campanhas pelo PC ao mesmo tempo. Cada máquina tem o seu `historico.json`, então as duas não sabem quem a outra já contatou e podem repetir empresas. Conecte os WhatsApps de novo pelo painel online (QR novo); a mesma sessão não pode ficar ativa em duas máquinas.

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

`web/index.html` define a estrutura; `web/styles.css` contém os tokens e estilos; `web/components.js`, `web/views.js` e `web/runtime-views.js` renderizam a interface; `web/app.js` coordena as interações e os eventos em tempo real. `server.js` serve a aplicação e a API (no PC ou na VPS), `bot/auth.js` cuida do login, `deploy/` instala e atualiza a VPS, enquanto `bot/runtime.js`, `bot/whatsapp.js`, `bot/campaign.js`, `bot/logger.js` e `bot/storage.js` gerenciam conexões, campanhas, logs e persistência.

As animações usam entradas breves, feedback de clique e uma abertura com órbitas. Não há carregamento de fontes, imagens ou scripts de terceiros.

O servidor sempre escuta somente em localhost; na VPS, quem recebe a internet é o Caddy. O painel online exige login (cookie `HttpOnly`, `Secure`, válido por 30 dias, assinado com a chave `.orbita/sessao.key`, que fica fora do Git). Chaves do Google e credenciais do WhatsApp não são enviadas ao navegador.

## Validação

Os testes ficam com você, conforme solicitado. Não foram executados testes, iniciado o bot nem realizado deploy nesta alteração.
