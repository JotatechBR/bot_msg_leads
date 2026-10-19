# Órbita · Seu espaço de prospecção

Painel para o bot de leads do Google Maps e WhatsApp. Use `npm start` para executar localmente e a integração com o GitHub para publicar o painel na Vercel.

## Abrir o painel

É necessário Node.js 20.12 ou superior.

```bash
npm start
```

Acesse **http://localhost:3001** no navegador. O projeto inicia somente em localhost, sem opções de acesso pela rede. Para desenvolvimento, `npm run dev` reinicia o servidor quando os arquivos mudam. Recarregue o navegador após editar a interface. Se a porta estiver ocupada, use `PORT=3002 npm start`.

## Publicar na Vercel

Importe o repositório na Vercel e faça o deploy usando a raiz do projeto. O `vercel.json` já aponta para `web/` e encaminha as chamadas da API para `api/index.js`. A instalação das dependências usa o fluxo padrão da plataforma.

Não há configuração de acesso por rede, URL de servidor externo, banco Redis ou worker adicional.

**Limite desta publicação:** na Vercel, o painel permite consultar o histórico e os rascunhos incluídos no deploy. A edição dos arquivos, o pareamento do WhatsApp e a execução contínua de campanhas permanecem disponíveis na execução local com `npm start`. O painel publicado informa essa condição e desativa os controles de alteração.

O motor atual mantém sessões em disco e conexões contínuas com o WhatsApp. O deploy padrão por [Vercel Functions](https://vercel.com/docs/functions/limitations) executa requisições com duração limitada; ele não equivale a manter `npm start` em execução. Por isso, a API publicada não inicia tarefas em segundo plano que seriam interrompidas após a requisição. Os dados publicados refletem os arquivos do último deploy, não as alterações feitas depois no seu computador.

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

`web/index.html` define a estrutura; `web/styles.css` contém os tokens e estilos; `web/components.js`, `web/views.js` e `web/runtime-views.js` renderizam a interface; `web/app.js` coordena as interações e os eventos em tempo real. `server.js` serve a aplicação local e `api/index.js` fornece as consultas na Vercel, enquanto `bot/runtime.js`, `bot/whatsapp.js`, `bot/campaign.js`, `bot/logger.js` e `bot/storage.js` gerenciam conexões, campanhas, logs e persistência.

As animações usam entradas breves, feedback de clique e uma abertura com órbitas. Não há carregamento de fontes, imagens ou scripts de terceiros.

O servidor local inicia somente em localhost. A publicação pública usa o domínio da Vercel e permanece sem login. Chaves do Google e credenciais do WhatsApp não são enviadas ao navegador.

## Validação

Os testes ficam com você, conforme solicitado. Não foram executados testes, iniciado o bot nem realizado deploy nesta alteração.
