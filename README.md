# Volta, Luz!

Jogo educativo em **3D** desenvolvido para navegador. O jogador precisa investigar um apagão na casa da avó, identificar o problema no circuito e descobrir, por meio de pistas, a ordem correta para religar os aparelhos.

## Visão geral

A missão combina exploração em primeira pessoa, interação com objetos e resolução de um quebra-cabeça lógico. Durante a partida, o jogador encontra ferramentas, examina o quadro de fusíveis e reúne pistas que permitem deduzir a sequência dos quatro aparelhos.

A ordem dos aparelhos muda a cada partida, evitando que a solução dependa apenas de memorizar uma sequência anterior.

## Objetivos de aprendizagem

- Praticar observação, interpretação de pistas e dedução.
- Resolver um problema por etapas.
- Conhecer, em contexto fictício e educativo, conceitos básicos relacionados a fusíveis, disjuntores e segurança elétrica.

## Como jogar

1. Explore a casa e encontre as luvas de proteção.
2. Abra o compartimento dos fusíveis e utilize a lanterna.
3. Use o multímetro para verificar o circuito.
4. Retire o fusível queimado, coloque o reserva e aperte-o.
5. Ligue o disjuntor geral.
6. Encontre as três pistas espalhadas pelo ambiente.
7. Consulte o caderno para combinar as informações e deduzir a ordem dos quatro aparelhos.
8. Ligue os aparelhos na sequência identificada.

O jogo também apresenta um extintor para a situação de incêndio simulada. Erros não encerram imediatamente a partida, permitindo novas tentativas.

## Controles

| Tecla / comando | Ação |
|---|---|
| `W`, `A`, `S`, `D` | Movimentar o personagem |
| `Shift` | Correr |
| Mouse | Olhar ao redor |
| `E` ou clique | Interagir com objetos |
| `1` a `5` | Selecionar ferramentas |
| `4` | Ativar a lanterna |
| `0` ou `Q` | Ficar com as mãos livres |
| `Tab` | Abrir ou fechar o caderno de pistas |
| `H` | Solicitar uma dica ao gato Fusível |
| `Esc` | Pausar o jogo |

Há também controles de toque para dispositivos compatíveis.

## Recursos técnicos

Um dos destaques do projeto é a implementação de um motor gráfico próprio em JavaScript, utilizando **WebGL 2.0**, sem depender de uma biblioteca externa de jogos 3D.

Entre os recursos implementados no código estão:

- Geometria low-poly com iluminação por vértice.
- Shaders e pipeline de renderização próprios.
- Shadow mapping com PCF para suavização de sombras.
- Renderização HDR quando as extensões necessárias estão disponíveis.
- MSAA e pós-processamento, incluindo bloom e tone mapping.
- Ajuste dinâmico da resolução para ajudar a manter a fluidez.
- Efeitos sonoros e música gerados por código.
- Sistema de partículas e lógica de interação do jogo.

A disponibilidade de alguns recursos gráficos depende do suporte do navegador e da GPU.

## Tecnologias

- **HTML5** — estrutura das telas e elementos da interface.
- **CSS3** — menus, HUD e apresentação visual.
- **JavaScript** — motor gráfico, lógica, interações e fluxo da partida.
- **WebGL 2.0** — renderização tridimensional no navegador.

## Executar localmente

### Requisitos

- Navegador moderno com suporte a WebGL 2.0.
- JavaScript habilitado.

Clone o repositório:

~~~bash
git clone https://github.com/0xNicolinux/Volta-Luz.git
cd Volta-Luz
~~~

Mantenha os arquivos principais juntos:

~~~text
volta-luz/
├── index.html
├── styles.css
└── script.js
~~~

Abra `index.html` em um navegador compatível. Para uma execução mais consistente, utilize um servidor HTTP local, por exemplo, a extensão Live Server do Visual Studio Code.

## Segurança e contexto educativo

As tarefas elétricas são simulações. O jogo não substitui orientação profissional: intervenções reais em quadros elétricos e instalações devem ser realizadas por profissionais qualificados.

## Licença

Consulte o arquivo [LICENSE](./LICENSE) para informações sobre uso e distribuição.