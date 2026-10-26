# 💡 Volta, Luz!

**Volta, Luz!** é um jogo 3D desenvolvido como projeto educacional para o SENAI. O jogo combina exploração, resolução de problemas, raciocínio lógico e dedução em uma missão para restabelecer a energia da casa da avó após um apagão.

## 🎮 Sobre o jogo

A energia acabou no bairro, e a casa da avó está completamente no escuro. O jogador precisa investigar o ambiente, encontrar pistas, utilizar ferramentas e descobrir a sequência correta para ligar quatro aparelhos sem provocar uma sobrecarga.

Mais do que completar uma missão, o jogador precisa observar informações, interpretar pistas e tomar decisões com base na lógica.

## 🧠 Objetivos do projeto

- Estimular o raciocínio lógico e a capacidade de dedução.
- Desenvolver a interpretação de pistas e a resolução de problemas.
- Apresentar conceitos básicos de eletricidade de forma interativa.
- Explorar o desenvolvimento de jogos utilizando tecnologias web.
- Proporcionar uma experiência de aprendizagem por meio da interação e da experimentação.

## 🕹️ Como jogar

O objetivo principal é restabelecer a energia da casa e descobrir a ordem correta para ligar os aparelhos.

1. Explore a casa e encontre as luvas de proteção.
2. Abra o compartimento dos fusíveis e utilize a lanterna para enxergar melhor.
3. Utilize o multímetro para verificar o circuito, retire o fusível queimado, coloque o reserva e aperte-o.
4. Ligue o disjuntor geral.
5. Encontre as três pistas espalhadas pelo ambiente.
6. Use o caderno de pistas para analisar as informações e deduzir a ordem correta dos quatro aparelhos.
7. Ligue os aparelhos seguindo a sequência descoberta.
8. Caso ocorra um incêndio durante a missão, utilize o extintor.

Os erros não encerram a partida imediatamente, permitindo que o jogador aprenda com as tentativas e continue avançando.

## 🔎 Sistema de lógica e dedução

O principal desafio do jogo está na resolução de um quebra-cabeça baseado em pistas.

Durante a exploração, o jogador encontra informações que ajudam a determinar a ordem correta dos aparelhos. Essas pistas precisam ser interpretadas em conjunto para eliminar possibilidades e chegar à sequência que resolve o desafio.

O sistema também conta com um caderno de pistas, que auxilia na organização das informações e no acompanhamento do progresso.

A cada nova partida, a ordem dos aparelhos é alterada, incentivando o jogador a raciocinar novamente em vez de apenas memorizar uma solução anterior.

## ⌨️ Controles

| Tecla ou comando | Ação |
|---|---|
| `W`, `A`, `S`, `D` | Movimentar o personagem |
| `Shift` | Correr |
| Mouse | Olhar ao redor |
| `E` ou clique | Interagir com objetos |
| `1` a `5` | Selecionar ferramentas |
| `4` | Ativar a lanterna |
| `0` ou `Q` | Ficar com as mãos livres |
| `Tab` | Abrir o caderno de pistas |
| `H` | Solicitar uma dica ao gato Fusível |
| `Esc` | Pausar o jogo |

O jogo também possui controles de toque para dispositivos compatíveis.

## 🛠️ Tecnologias utilizadas

- **HTML5:** estrutura das telas, menus e elementos da interface.
- **CSS3:** estilização, layout, animações e adaptação da interface.
- **JavaScript:** lógica do jogo, movimentação, interações, sistema de pistas e gerenciamento da partida.
- **WebGL 2.0:** renderização gráfica do ambiente tridimensional diretamente no navegador.

O projeto utiliza um motor gráfico próprio implementado em JavaScript com WebGL 2.0, sem depender de uma biblioteca de jogos 3D externa.

Entre os recursos gráficos implementados estão modelos geométricos no estilo *low poly*, iluminação, sombras, efeitos de brilho e pós-processamento. O jogo também inclui efeitos sonoros e música gerados por código.

## 🚀 Como executar

### Requisitos

- Navegador moderno com suporte a WebGL 2.0.
- JavaScript habilitado.
- Os três arquivos principais do projeto.

### Executando localmente

1. Baixe ou clone este repositório.
2. Mantenha os arquivos `index.html`, `styles.css` e `script.js` na mesma pasta.
3. Abra o arquivo `index.html` em um navegador compatível.

Para uma execução mais consistente, recomenda-se iniciar um servidor HTTP local, utilizando, por exemplo, a extensão **Live Server** do Visual Studio Code.

### Estrutura do projeto

```text
volta-luz/
├── index.html   # Estrutura da página e telas do jogo
├── styles.css   # Estilos e interface visual
└── script.js    # Motor gráfico e lógica do jogo
```

## ⚡ Aprendizados sobre eletricidade

Ao concluir a missão, o jogador tem contato com conceitos básicos relacionados à segurança elétrica:

- A função do fusível na proteção de um circuito.
- A atuação do disjuntor diante de uma corrente excessiva.
- Os riscos de ligar vários aparelhos sem considerar a capacidade do circuito.
- O perigo da combinação entre água e eletricidade.

**Importante:** as atividades elétricas representadas no jogo são fictícias e educativas. Na vida real, intervenções em instalações elétricas devem ser realizadas por profissionais qualificados.

*Volta, Luz! — investigue as pistas, descubra a sequência e faça a luz voltar!* 💡
