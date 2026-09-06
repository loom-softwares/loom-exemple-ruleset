# 🎲 Loom Demo System — Guia & Template Oficial de Desenvolvimento

O **Loom Demo System** (`loom-demo-system`) é o sistema de referência oficial e modelo pedagógico para o **LoomVTT**. Ele foi projetado para servir como um **guia prático e código-base inicial (boilerplate)** para desenvolvedores que desejam aprender a criar ou customizar seus próprios sistemas de RPG dentro do LoomVTT.

Distribuído sob a **[Licença MIT](./LICENSE)**: você tem total liberdade para clonar, modificar, renomear, distribuir e comercializar qualquer sistema criado a partir deste código.

---

## 🧭 Índice do Guia

1. [Visão Geral e Arquitetura](#-visão-geral-e-arquitetura)
2. [Estrutura de Pastas e Arquivos](#-estrutura-de-pastas-e-arquivos)
3. [Regra de Ouro: O Manifesto `ruleset.json` e Segurança](#-regra-de-ouro-o-manifesto-rulesetjson-e-segurança)
4. [As Duas Formas de Criar Fichas no Loom](#-as-duas-formas-de-criar-fichas-no-loom)
   - [A. Ficha Declarativa (Schema-based)](#a-ficha-declarativa-schema-based-rápida-e-automática)
   - [B. Ficha Customizada (Handlebars `.hbs`)](#b-ficha-customizada-handlebars-hbs--mixin)
5. [Sincronização de Dados e Auto-Save (`sd:`)](#-sincronização-de-dados-e-auto-save-sd)
6. [Derivação de Dados (`prepare-data.mjs`)](#-derivação-de-dados-prepare-datamjs)
7. [Caixa de Rolagem & Detecção Contextual de Alvo (Target)](#-caixa-de-rolagem--detecção-contextual-de-alvo-target)
8. [Iniciativa & Sincronização com o Combat Tracker (`Loom.combat`)](#-iniciativa--sincronização-com-o-combat-tracker-loomcombat)
9. [Ficha de Itens (`DemoItemSheet`) e Inventário](#-ficha-de-itens-demoitemsheet-e-inventário)
10. [Customização dos Cards de Chat (`renderMessage.wrap`)](#-customização-dos-cards-de-chat-rendermessagewrap)
11. [Passo a Passo: Como Criar o Seu Próprio Sistema](#-passo-a-passo-como-criar-o-seu-próprio-sistema)
12. [Validação de Código e Sintaxe](#-validação-de-código-e-sintaxe)
13. [Licença](#-licença)

---

## 🌟 Visão Geral e Arquitetura

O LoomVTT adota o padrão **Web Nativo**:
- **100% Client-Side:** Sistemas rodam diretamente no navegador do jogador e do mestre. O servidor do LoomVTT **nunca executa código de sistema**, garantindo segurança e desempenho extremos.
- **Zero Build Tools:** Não é necessário Webpack, Vite, React ou Babel. Apenas JavaScript puro (ES Modules `.mjs`), templates Handlebars (`.hbs`) e CSS puro (`.css`).
- **Dois Modelos Lado a Lado:** Mostra intencionalmente uma ficha declarativa simples (`villain`, `beast`) e uma ficha rica em Handlebars (`hero`) para você comparar diretamente a complexidade de cada uma.

---

## 📂 Estrutura de Pastas e Arquivos

```
loom-demo-system/
├── LICENSE                  # Licença MIT permissiva para desenvolvedores
├── README.md                # Este guia didático
├── ruleset.json             # Manifesto estático lido pelo servidor (tipos, estilos, i18n)
├── main.mjs                  # Entry point do cliente: defineSystem, hooks, wraps e registro
├── data/
│   ├── hero.mjs              # Valores padrão (defaults) do tipo de ator "hero"
│   ├── villain.mjs           # Valores padrão do "villain"
│   ├── beast.mjs             # Valores padrão do "beast"
│   └── prepare-data.mjs      # Funções de cálculo de bônus derivados, defesas e atributos
├── sheets/
│   ├── hero-sheet.mjs        # Classe da ficha do Herói estendendo LoomHandlebarsMixin(LoomActorSheet)
│   └── item-sheet.mjs        # Classe da ficha de Itens estendendo LoomHandlebarsMixin(LoomItemSheet)
├── templates/
│   ├── hero-sheet.hbs        # Template visual em HTML/Handlebars da ficha do Herói
│   └── item-sheet.hbs        # Template visual em HTML/Handlebars da ficha de Itens
├── styles/
│   └── system.css            # Folha de estilo completa (fichas, caixas de rolagem, chat cards)
└── lang/
    ├── pt-BR.json            # Traduções para Português do Brasil
    └── en.json               # Traduções para Inglês
```

---

## 🔒 Regra de Ouro: O Manifesto `ruleset.json` e Segurança

Como o servidor do LoomVTT nunca executa seu arquivo JavaScript, ele consulta o arquivo estático `ruleset.json` para saber quais dados são válidos no banco de dados.

```json
{
  "name": "loom-demo-system",
  "title": "Loom Demo System",
  "version": "0.1.0",
  "engine": "loom",
  "type": "ruleset",
  "client": "main.mjs",
  "actorTypes": ["hero", "villain", "beast"],
  "itemTypes": ["weapon", "armor", "potion", "scroll"],
  "styles": ["styles/system.css"],
  "languages": [
    { "lang": "pt-BR", "name": "Português", "path": "lang/pt-BR.json" },
    { "lang": "en", "name": "English", "path": "lang/en.json" }
  ]
}
```

> [!IMPORTANT]
> 1. **`actorTypes` e `itemTypes`:** As rotas de API `/api/actors` e `/api/items` validam o tipo de documento contra essas listas. Se você criar um novo tipo no código sem colocá-lo no manifesto, o servidor recusará a criação do ator/item!
> 2. **`styles`:** O Loom só injetará seu CSS na página se o arquivo estiver explicitamente declarado no array `"styles"`.

---

## 📑 As Duas Formas de Criar Fichas no Loom

### A. Ficha Declarativa (Schema-based) — Rápida e Automática
Usada para monstros, PdMs ou sistemas minimalistas. Não precisa de template `.hbs`. Definida diretamente no método `getSheetSchema(actorType)` em `main.mjs`:

```javascript
getSheetSchema(actorType) {
  return {
    tabs: [
      {
        id: 'attributes',
        label: 'Attributes',
        fields: [
          { key: 'attributes.might', label: 'Might', type: 'dots', max: 10 },
          { key: 'defense', label: 'Defense', type: 'number' }
        ]
      }
    ]
  };
}
```
**Vantagens:** O LoomVTT cria a janela, abas, inputs e a aba nativa de Active Effects (Buffs) automaticamente.

---

### B. Ficha Customizada (Handlebars `.hbs` + Mixin)
Usada para fichas ricas com design próprio (como o nosso `hero` e `item`).

1. **Defina a classe da ficha:**
```javascript
import { LoomHandlebarsMixin, LoomActorSheet } from '/_loom/sdk/index.js';

export class HeroSheet extends LoomHandlebarsMixin(LoomActorSheet) {
  static PARTS = {
    main: { template: '/marketplace/rulesets/loom-demo-system/templates/hero-sheet.hbs' }
  };

  constructor(props) {
    super({
      ...props,
      id: props.id || `actor-sheet-${props.actorId}`,
      documentId: props.actorId, // CRUCIAL: Sem isso o Loom não sabe qual documento carregar!
    });
    this.actorId = props.actorId;
  }
}
```

2. **Registre a ficha no catálogo em `main.mjs`:**
```javascript
import { sheets } from '/_loom/sdk/index.js';
import { HeroSheet } from './sheets/hero-sheet.mjs';

sheets.catalog('actor', 'hero', HeroSheet);
sheets.catalog('item', '*', DemoItemSheet);
```

---

## ⚡ Sincronização de Dados e Auto-Save (`sd:`)

O LoomVTT possui um sistema automático de sincronização bidirecional de formulários chamado `LoomFormData`. Você **não precisa** escrever eventos de `onChange` ou `onInput` para cada campo!

Use a convenção de atributos `name`:
- `name="name"` ➔ Salva na propriedade raiz do documento (`actor.name`).
- `name="sd:defense"` ➔ Salva dentro de `actor.systemData.defense`.
- `name="sd:attributes:might"` (ou `sd:attributes.might`) ➔ Salva em `actor.systemData.attributes.might`.

---

## 🧮 Derivação de Dados (`prepare-data.mjs`)

Em qualquer RPG, existem dados salvos no banco (ex: pontuação de atributo 8) e dados derivados calculados em tempo real (ex: bônus de ataque +4, HP máximo, etc.).

No Loom, a função `prepareData(actor)` roda no cliente toda vez que o ator é carregado ou editado:

```javascript
export function prepareHero(actor) {
  const attrs = actor.systemData?.attributes || { might: 5, swift: 5, wits: 5 };
  
  // Calcula bônus derivados
  actor._bonus = {
    attack: Math.floor((attrs.might ?? 5) / 2),
    dodge: Math.floor((attrs.swift ?? 5) / 2),
    initiative: Math.floor((attrs.swift ?? 5) / 2),
  };

  // Garante defesa calculada
  actor.defense = actor.systemData?.defense ?? (10 + actor._bonus.dodge);
}
```

---

## 🎯 Caixa de Rolagem & Detecção Contextual de Alvo (Target)

Ao clicar em ações ou atributos, o `HeroSheet` abre a Caixa de Rolagem usando `LoomDialog.wait()`:

```javascript
// Detecta se o jogador tem um alvo selecionado na mesa (canvas)
const targets = window.Loom?.user?.targets || [];
const target = targets[0]; // Retorna { name, defense, avatar, ... }

// Se houver alvo, preenche a Dificuldade padrão com a Defesa dele!
const defaultDC = target ? target.defense : 10;
```

A caixa permite:
1. Ver o card com nome e avatar do alvo marcado.
2. Ajustar a DC do teste ou modificador situacional (+/-).
3. Selecionar modo de rolagem: **Normal** (`1d20`), **Vantagem** (`2d20kh1`) ou **Desvantagem** (`2d20kl1`).
4. Disparar a rolagem com `window.Loom.dispatchRoll({ formula, actorId, meta: { ... } })`.

---

## ⚔️ Iniciativa & Sincronização com o Combat Tracker (`Loom.combat`)

A iniciativa funciona de forma única e especializada:
1. **Sem Alvo nem DC:** Diferente de um ataque, iniciativa é uma rolagem de ordenação. Por isso, a janela de iniciativa não exibe alvos nem campos de dificuldade/defesa.
2. **Integração com `Loom.combat`:**
   Ao rolar a iniciativa, o sistema verifica se há um combate ativo no mundo e localiza o combatente do ator:
   ```javascript
   const activeCombat = window.Loom?.combat;
   const combatant = activeCombat?.combatants?.find(c => c.actorId === this.actorId);
   ```
3. **Atualização Automática dos Turnos:**
   O resultado do dado é enviado ao chat e atualiza o combatente no Combat Tracker:
   ```javascript
   window.Loom.combats.updateCombatant(worldId, combatant.castId, { initiative: totalRoll });
   ```
   A barra lateral de combate reordena a rodada instantaneamente!

---

## 🎒 Ficha de Itens (`DemoItemSheet`) e Inventário

O sistema demonstra como criar itens manipuláveis com janelas próprias:
- **Herança de `LoomItemSheet`:** Classe `DemoItemSheet` em `sheets/item-sheet.mjs`.
- **Troca de Ícone Nativa:** Elementos com `data-action="pick-portrait"` e `data-edit="imgUrl"` abrem automaticamente o modal de escolha de arquivos do LoomVTT.
- **Campos Específicos por Tipo:** O template `templates/item-sheet.hbs` exibe campos de Dano para armas, Defesa para armaduras e Cura para poções.
- **Rolagem de Dano:** Botão "Rolar Dano" integrado que lê a fórmula do item (ex: `1d8+2`) e joga no chat.

---

## 💬 Customização dos Cards de Chat (`renderMessage.wrap`)

O LoomVTT oferece o sistema de interceptação `getWraps()` para modificar componentes da interface sem alterar o core:

```javascript
getWraps().renderMessage.wrap((wrapped, msg, ctx) => {
  if (!msg.isRoll || msg.roll?.meta?.system !== 'Loom Demo') {
    return wrapped(msg, ctx); // Deixa outras mensagens intactas
  }

  // Renderiza nosso card temático com avatar do ator, breakdown dos dados
  // e badges de SUCESSO ou FALHA comparados contra a DC
  return `<div class="loom-demo-card">...</div>`;
});
```

---

## 🛠️ Passo a Passo: Como Criar o Seu Próprio Sistema

Para transformar este demo no seu próprio RPG:

1. **Renomeie o manifesto:**
   Abra `ruleset.json`, altere `"name"`, `"title"` e adicione os tipos de atores e itens que seu RPG usa.
2. **Adapte os dados padrão em `data/`:**
   Crie arquivos para seus tipos de ator (ex: `warrior.mjs`, `monster.mjs`) definindo atributos próprios (ex: Força, Destreza, Vontade, Mana).
3. **Atualize o cálculo derivado em `data/prepare-data.mjs`:**
   Implemente a matemática das suas regras (cálculo de bônus, limiar de ferimentos, defesas).
4. **Modifique o template visual em `templates/hero-sheet.hbs`:**
   Ajuste os nomes dos inputs para refletir seus atributos (sempre usando o prefixo `name="sd:meuAtributo"`).
5. **Estilize em `styles/system.css`:**
   Altere as variáveis de cores (`--rpg-gold`, paletas de fundo e fontes) para dar a identidade visual que o seu jogo merece.

---

## 🧪 Validação de Código e Sintaxe

Sempre valide a integridade dos seus scripts ES Modules antes de subir atualizações:

```bash
node --check main.mjs
node --check sheets/hero-sheet.mjs
node --check sheets/item-sheet.mjs
node --check data/prepare-data.mjs
```

---

## 📄 Licença

Este projeto está licenciado sob a **Licença MIT** — consulte o arquivo [LICENSE](./LICENSE) para mais detalhes.

Você é livre para usar, estudar, clonar, modificar e criar seus próprios sistemas de RPG para o LoomVTT a partir deste projeto sem restrições. Divirta-se criando mundos incríveis! 🚀
