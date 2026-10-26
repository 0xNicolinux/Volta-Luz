'use strict';
/* ==========================================================================
   VOLTA, LUZ!  ·  motor 3D próprio em WebGL2 + jogo (HTML + CSS + JS puros)

   Seções
     1. Utilidades e matemática (vec3 / mat4)
     2. Núcleo WebGL (programas, malhas, texturas)
     3. Construtor de malhas low poly (flat shading + AO por vértice)
     4. Shaders
     5. Renderer (sombras, HDR + MSAA, bloom, pós-processamento)
     6. Partículas
     7. Áudio procedural
     8. Mundo (casa, bairro, props)
     9. Lógica do jogo (puzzle, fases, interações)
    10. Interface (HUD, caderno, menus) e laço principal

   Decisões técnicas (resumo do que a pesquisa indicou):
   - Flat shading vem da própria malha (cada triângulo tem sua normal), sem
     texturas de detalhe: o visual low poly depende de paleta curta, silhueta
     clara e luz bem pensada, não de polígonos a mais.
   - AO "assado" por vértice (barato) no lugar de SSAO: em cenário estático
     dá o mesmo efeito de contato e custa zero em tempo de execução.
   - Render em HDR (RGBA16F) com MSAA 4x, bloom por pirâmide (downsample de
     13 taps + upsample tent aditivo), tone mapping ACES e color grading
     (sombras frias, luzes quentes). Gamma/sRGB feito manualmente no final.
   - Sombras: shadow map com comparação por hardware (sampler2DShadow) +
     PCF 3x3, polygon offset e bias ao longo da normal (evita acne sem
     descolar a sombra do objeto, o chamado "peter panning").
   - Escala de resolução dinâmica para manter fluidez em PCs fracos.
   ========================================================================== */

/* ============================ 1. UTILIDADES ============================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));      // suavização independente de FPS
const fmtTime = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');

/* PRNG determinístico (mulberry32): o cenário é idêntico em toda partida */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash3 = (x, y, z) => { // ruído de hash estável para deformar vértices
  let h = Math.imul(Math.round(x * 1000) | 0, 374761393) ^ Math.imul(Math.round(y * 1000) | 0, 668265263) ^ Math.imul(Math.round(z * 1000) | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const V3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)],
};

/* Matrizes 4x4 em Float32Array, ordem de colunas (padrão do OpenGL) */
const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(o, a, b) {
    const t = M4._t;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      t[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    o.set(t); return o;
  },
  _t: new Float32Array(16),
  perspective(o, fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    o.fill(0); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o;
  },
  ortho(o, l, r, b, t, n, f) {
    o.fill(0); o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1; return o;
  },
  lookAt(o, e, c, up) {
    const f = V3.norm(V3.sub(c, e)), s = V3.norm(V3.cross(f, up)), u = V3.cross(s, f);
    o[0] = s[0]; o[1] = u[0]; o[2] = -f[0]; o[3] = 0;
    o[4] = s[1]; o[5] = u[1]; o[6] = -f[1]; o[7] = 0;
    o[8] = s[2]; o[9] = u[2]; o[10] = -f[2]; o[11] = 0;
    o[12] = -V3.dot(s, e); o[13] = -V3.dot(u, e); o[14] = V3.dot(f, e); o[15] = 1; return o;
  },
  /* M = T * Ry * Rx * Rz * S  (escala uniforme) */
  compose(o, t, rx, ry, rz, s) {
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    o[0] = (cy * cz + sy * sx * sz) * s; o[1] = cx * sz * s;  o[2] = (-sy * cz + cy * sx * sz) * s; o[3] = 0;
    o[4] = (-cy * sz + sy * sx * cz) * s; o[5] = cx * cz * s; o[6] = (sy * sz + cy * sx * cz) * s;  o[7] = 0;
    o[8] = sy * cx * s;                  o[9] = -sx * s;     o[10] = cy * cx * s;                   o[11] = 0;
    o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1; return o;
  },
};

/* Cores: entram como #RRGGBB (sRGB) e são convertidas p/ linear, pois todo o
   cálculo de luz é feito em espaço linear e só no final voltamos p/ sRGB. */
const C = hex => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map(v => Math.pow(v, 2.2));
const mixC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const dimC = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/* ============================ 2. NÚCLEO WEBGL ============================ */
const canvas = $('#gl');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
if (!gl) { document.body.classList.add('no-webgl'); throw new Error('WebGL2 indisponível neste navegador.'); }
const EXT = {
  cbf: gl.getExtension('EXT_color_buffer_float'),
  chf: gl.getExtension('EXT_color_buffer_half_float'),
  aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
};
const HDR = !!(EXT.cbf || EXT.chf);

class Program {
  constructor(name, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('[' + name + '] ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
      return s;
    };
    this.name = name; this.p = gl.createProgram();
    gl.attachShader(this.p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(this.p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(this.p);
    if (!gl.getProgramParameter(this.p, gl.LINK_STATUS)) throw new Error('[' + name + '] ' + gl.getProgramInfoLog(this.p));
    this.u = {};
    for (let i = 0, n = gl.getProgramParameter(this.p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const info = gl.getActiveUniform(this.p, i);
      this.u[info.name.replace('[0]', '')] = gl.getUniformLocation(this.p, info.name);
    }
  }
  use() { gl.useProgram(this.p); return this; }
  i1(n, v) { gl.uniform1i(this.u[n], v); return this; }
  f1(n, v) { gl.uniform1f(this.u[n], v); return this; }
  f2(n, a, b) { gl.uniform2f(this.u[n], a, b); return this; }
  f3(n, v) { gl.uniform3f(this.u[n], v[0], v[1], v[2]); return this; }
  f4(n, a, b, c, d) { gl.uniform4f(this.u[n], a, b, c, d); return this; }
  fv(n, arr, comps) { (comps === 3 ? gl.uniform3fv : gl.uniform4fv).call(gl, this.u[n], arr); return this; }
  m4(n, m) { gl.uniformMatrix4fv(this.u[n], false, m); return this; }
}

/* Malha: buffer intercalado de 14 floats por vértice
   pos(3) normal(3) cor(3) mat(3: ao, emissivo, limiar) uv(2) */
const STRIDE = 14;
class Mesh {
  constructor(data) {
    this.count = data.length / STRIDE;
    this.min = [1e9, 1e9, 1e9]; this.max = [-1e9, -1e9, -1e9];          // limites locais (para raycast)
    for (let i = 0; i < data.length; i += STRIDE) for (let k = 0; k < 3; k++) { this.min[k] = Math.min(this.min[k], data[i + k]); this.max[k] = Math.max(this.max[k], data[i + k]); }
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const sizes = [3, 3, 3, 3, 2]; let off = 0;
    sizes.forEach((s, i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, s, gl.FLOAT, false, STRIDE * 4, off * 4); off += s; });
    gl.bindVertexArray(null);
  }
  draw() { gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, this.count); }
}

/* Textura a partir de canvas 2D (rótulos, bilhetes, telas). sRGB decodificado pelo hardware. */
function texFromCanvas(cv, { srgb = true, mips = true } = {}) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (EXT.aniso) gl.texParameterf(gl.TEXTURE_2D, EXT.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return t;
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/* ==================== 3. CONSTRUTOR DE MALHAS LOW POLY ==================== */
/* Todas as primitivas emitem triângulos "soltos" (sem índices): assim cada
   face guarda a própria normal e o flat shading sai de graça. O winding é
   corrigido automaticamente a partir de uma direção "para fora" (hint), o que
   elimina uma classe inteira de bugs de face invertida. */
class MeshBuilder {
  constructor(seed = 7) { this.d = []; this.m = M4.ident(); this.stack = []; this.rand = mulberry32(seed); }

  /* Aplica uma transformação local (posição, rotações, escala uniforme) a tudo que for desenhado dentro de fn */
  group(o, fn) {
    this.stack.push(this.m);
    const l = M4.compose(new Float32Array(16), o.pos || [0, 0, 0], o.rx || 0, o.ry || 0, o.rz || 0, o.s || 1);
    this.m = M4.mul(new Float32Array(16), this.m, l);
    fn(); this.m = this.stack.pop(); return this;
  }
  P(p) { const m = this.m, [x, y, z] = p; return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; }
  D(p) { const m = this.m, [x, y, z] = p; return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z]; }

  /* Emite um polígono convexo (3 ou 4 pontos). `out` = direção aproximada da normal. */
  face(pts, out, col, ao = 1, em = 0, th = 0, uvs = null) {
    let P = pts.map(p => this.P(p));
    const hint = this.D(out);
    let n = V3.cross(V3.sub(P[1], P[0]), V3.sub(P[2], P[0]));
    let flip = V3.dot(n, hint) < 0;
    if (flip) { P = P.slice().reverse(); if (uvs) uvs = uvs.slice().reverse(); if (Array.isArray(ao)) ao = ao.slice().reverse(); }
    n = V3.norm(V3.cross(V3.sub(P[1], P[0]), V3.sub(P[2], P[0])));
    const aoAt = i => (Array.isArray(ao) ? ao[i] : ao);
    const emit = i => this.d.push(P[i][0], P[i][1], P[i][2], n[0], n[1], n[2], col[0], col[1], col[2], aoAt(i), em, th, uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0);
    emit(0); emit(1); emit(2);
    if (P.length === 4) { emit(0); emit(2); emit(3); }
    return this;
  }

  /* Caixa centrada em (x,y,z). o.ao = escurecimento da base (0..1), o.em / o.th = emissivo e limiar, o.j = variação de cor por face */
  box(x, y, z, w, h, d, col, o = {}) {
    const hx = w / 2, hy = h / 2, hz = d / 2, aob = o.ao ?? 0.62, em = o.em || 0, th = o.th || 0, j = o.j ?? 0.045;
    const x0 = x - hx, x1 = x + hx, y0 = y - hy, y1 = y + hy, z0 = z - hz, z1 = z + hz;
    const jc = () => { const k = 1 + (this.rand() - 0.5) * 2 * j; return [col[0] * k, col[1] * k, col[2] * k]; };
    const skip = o.skip || '', K = o.k ?? 1;      // K escurece todo o AO (cavidades, interior do quadro)
    const aob_ = aob * K, one = K, low = 0.45 * K;
    if (!skip.includes('t')) this.face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], jc(), one, em, th);
    if (!skip.includes('b')) this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], jc(), low, em, th);
    if (!skip.includes('r')) this.face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], jc(), [aob_, aob_, one, one], em, th);
    if (!skip.includes('l')) this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], jc(), [aob_, aob_, one, one], em, th);
    if (!skip.includes('f')) this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], jc(), [aob_, aob_, one, one], em, th);
    if (!skip.includes('k')) this.face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], jc(), [aob_, aob_, one, one], em, th);
    return this;
  }

  /* Cilindro/tronco de cone vertical. rt = raio do topo, rb = raio da base. */
  cyl(x, y, z, rt, rb, h, seg, col, o = {}) {
    const y0 = y - h / 2, y1 = y + h / 2, aob = o.ao ?? 0.65, em = o.em || 0, th = o.th || 0, j = o.j ?? 0.04, rot = o.rot || 0;
    const pt = (a, r, yy) => [x + Math.cos(a) * r, yy, z + Math.sin(a) * r];
    for (let i = 0; i < seg; i++) {
      const a0 = rot + i / seg * TAU, a1 = rot + (i + 1) / seg * TAU, am = (a0 + a1) / 2;
      const k = 1 + (this.rand() - 0.5) * 2 * j, cc = [col[0] * k, col[1] * k, col[2] * k], out = [Math.cos(am), 0.2, Math.sin(am)];
      if (rt > 1e-5) this.face([pt(a0, rb, y0), pt(a1, rb, y0), pt(a1, rt, y1), pt(a0, rt, y1)], out, cc, [aob, aob, 1, 1], em, th);
      else this.face([pt(a0, rb, y0), pt(a1, rb, y0), [x, y1, z]], out, cc, [aob, aob, 1], em, th);
      if (rt > 1e-5 && !o.open) this.face([[x, y1, z], pt(a1, rt, y1), pt(a0, rt, y1)], [0, 1, 0], cc, 1, em, th);
      if (!o.open) this.face([[x, y0, z], pt(a0, rb, y0), pt(a1, rb, y0)], [0, -1, 0], cc, 0.5, em, th);
    }
    return this;
  }
  cone(x, y, z, r, h, seg, col, o = {}) { return this.cyl(x, y, z, 0, r, h, seg, col, o); }

  /* Icosfera facetada (detalhe 0 = 20 faces, 1 = 80). jit deforma os vértices para pedras/folhagem. */
  sphere(x, y, z, r, col, o = {}) {
    const det = o.det ?? 1, jit = o.jit || 0, ry = (o.ry ?? 1) * r, em = o.em || 0, th = o.th || 0, aob = o.ao ?? 0.7, j = o.j ?? 0.05;
    const t = (1 + Math.sqrt(5)) / 2;
    let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(V3.norm);
    let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < det; s++) {
      const cache = {}, mid = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (cache[k] === undefined) { v.push(V3.norm(V3.mul(V3.add(v[a], v[b]), 0.5))); cache[k] = v.length - 1; } return cache[k]; };
      const nf = []; f.forEach(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }); f = nf;
    }
    const pos = v.map(p => { const k = 1 + (jit ? (hash3(p[0], p[1], p[2]) - 0.5) * 2 * jit : 0); return [x + p[0] * r * k, y + p[1] * ry * k, z + p[2] * r * k]; });
    f.forEach(([a, b, c]) => {
      const cen = V3.mul(V3.add(V3.add(pos[a], pos[b]), pos[c]), 1 / 3), out = V3.sub(cen, [x, y, z]);
      const k = 1 + (this.rand() - 0.5) * 2 * j;
      const ao = [a, b, c].map(i => lerp(aob, 1, clamp((pos[i][1] - (y - ry)) / (2 * ry), 0, 1)));
      this.face([pos[a], pos[b], pos[c]], out, [col[0] * k, col[1] * k, col[2] * k], ao, em, th);
    });
    return this;
  }

  /* Prisma triangular (telhado / orelha): cumeeira ao longo de z, base em y-h/2 */
  wedge(x, y, z, w, h, d, col, o = {}) {
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2, z0 = z - d / 2, z1 = z + d / 2, em = o.em || 0;
    this.face([[x0, y0, z0], [x0, y0, z1], [x, y1, z1], [x, y1, z0]], [-1, 1, 0], col, [0.7, 0.7, 1, 1], em);
    this.face([[x1, y0, z1], [x1, y0, z0], [x, y1, z0], [x, y1, z1]], [1, 1, 0], dimC(col, 1.05), [0.7, 0.7, 1, 1], em);
    this.face([[x0, y0, z1], [x1, y0, z1], [x, y1, z1]], [0, 0, 1], dimC(col, 0.92), [0.7, 0.7, 1], em);
    this.face([[x1, y0, z0], [x0, y0, z0], [x, y1, z0]], [0, 0, -1], dimC(col, 0.92), [0.7, 0.7, 1], em);
    this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], dimC(col, 0.6), 0.5, em);
    return this;
  }

  /* Plano texturizado olhando para +z (use dentro de group para girar). */
  plane(x, y, z, w, h, col = [1, 1, 1], o = {}) {
    const hx = w / 2, hy = h / 2;
    this.face([[x - hx, y - hy, z], [x + hx, y - hy, z], [x + hx, y + hy, z], [x - hx, y + hy, z]], [0, 0, 1], col, o.ao ?? 1, o.em || 0, o.th || 0, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    return this;
  }

  /* Quadrilátero livre (útil para feixes de luz, janelas, etc.) */
  quad(a, b, c, d, out, col, ao = 1, em = 0, th = 0) { return this.face([a, b, c, d], out, col, ao, em, th); }

  build() { return new Mesh(this.d); }
}

/* ============================== 4. SHADERS =============================== */
const GLSL = {};

/* ---- cena: vertex ---- */
GLSL.sceneVS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in vec3 aMat;   // x = AO, y = emissivo, z = limiar (janelas da cidade)
layout(location=4) in vec2 aUV;
uniform mat4 uModel, uViewProj;
out vec3 vW; out vec3 vN; out vec3 vC; out vec3 vM; out vec2 vUV;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uModel) * aNrm; vC = aCol; vM = aMat; vUV = aUV;
  gl_Position = uViewProj * w;
}`;

/* ---- cena: fragment (iluminação inteira num lugar só) ---- */
GLSL.sceneFS = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 vW; in vec3 vN; in vec3 vC; in vec3 vM; in vec2 vUV;
out vec4 oColor;
uniform sampler2D uMap; uniform float uUseMap;
uniform sampler2DShadow uSh0, uSh1;
uniform mat4 uSM0, uSM1;
uniform vec4 uShP;              // x,y = tamanho do texel de mundo (mapas 0 e 1), z,w = texel UV
uniform vec3 uCam;
uniform vec3 uSky, uGround;     // ambiente hemisférico
uniform vec3 uD0, uC0;          // luz 0 (lua): direção PARA a luz, cor
uniform vec3 uD1, uC1;          // luz 1 (teto): idem
uniform vec4 uPL[8]; uniform vec3 uPLC[8]; uniform int uPLN;   // luzes pontuais
uniform vec3 uSpotP, uSpotD, uSpotC; uniform vec2 uSpotCone; uniform float uSpotOn;  // lanterna
uniform vec3 uTint; uniform float uPower, uHi, uSpec, uAlpha, uWet, uTime;
uniform vec3 uFog; uniform float uFogD;
uniform vec3 uRim;
uniform float uAmbK, uD1K;      // exterior: ambiente reduzido e sem a luz de teto

float shadowAt(sampler2DShadow s, mat4 vp, vec3 wp, vec3 n, float nl, float texW, float texUV){
  // bias ao longo da normal: cresce quando a superfície fica rasante à luz
  vec3 p = wp + n * texW * (1.4 + 3.2 * (1.0 - nl));
  vec4 c = vp * vec4(p, 1.0);
  vec3 q = c.xyz / c.w * 0.5 + 0.5;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0 || q.z > 1.0) return 1.0;
  float sum = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
    sum += texture(s, vec3(q.xy + vec2(float(i), float(j)) * texUV, q.z - 0.0005));
  return sum / 9.0;     // cada tap já é um PCF 2x2 por hardware
}

void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCam - vW);
  vec4 tx = (uUseMap > 0.5) ? texture(uMap, vUV) : vec4(1.0);
  vec3 albedo = vC * uTint * tx.rgb;
  float ao = vM.x;

  vec3 amb = mix(uGround, uSky, N.y * 0.5 + 0.5) * ao * uAmbK;

  float nl0 = clamp(dot(N, uD0), 0.0, 1.0);
  float nl1 = clamp(dot(N, uD1), 0.0, 1.0);
  float sh0 = (nl0 > 0.0 && dot(uC0, vec3(1.0)) > 0.001) ? shadowAt(uSh0, uSM0, vW, N, nl0, uShP.x, uShP.z) : 1.0;
  float sh1 = (nl1 > 0.0 && dot(uC1, vec3(1.0)) > 0.001) ? shadowAt(uSh1, uSM1, vW, N, nl1, uShP.y, uShP.w) : 1.0;
  vec3 dirL = uC0 * nl0 * sh0 + uC1 * nl1 * sh1 * uD1K;

  vec3 pl = vec3(0.0);
  for (int i = 0; i < 8; i++){
    if (i >= uPLN) break;
    vec3 d = uPL[i].xyz - vW; float dist = length(d);
    float att = clamp(1.0 - dist / uPL[i].w, 0.0, 1.0); att *= att;
    float nl = clamp((dot(N, d / dist) + 0.25) / 1.25, 0.0, 1.0);   // "wrap": sombra mais suave, bom p/ low poly
    pl += uPLC[i] * att * nl * mix(1.0, ao, 0.6);
  }

  vec3 spot = vec3(0.0);
  if (uSpotOn > 0.001){
    vec3 sd = uSpotP - vW; float dist = length(sd); vec3 L = sd / dist;
    float cone = smoothstep(uSpotCone.y, uSpotCone.x, dot(-L, uSpotD));
    spot = uSpotC * cone * max(dot(N, L), 0.0) / (1.0 + dist * dist * 0.28) * uSpotOn;
  }

  vec3 col = albedo * (amb + dirL + pl + spot);

  // brilho especular facetado: dá "cintilância" aos planos do low poly
  vec3 H0 = normalize(uD0 + V), H1 = normalize(uD1 + V);
  float sp = pow(max(dot(N, H0), 0.0), 38.0) * nl0 * sh0 * dot(uC0, vec3(0.33)) + pow(max(dot(N, H1), 0.0), 38.0) * nl1 * sh1 * dot(uC1, vec3(0.33));
  col += vec3(1.0, 0.95, 0.85) * sp * uSpec;

  // luz de contorno (rim) fria: destaca a silhueta no escuro
  col += uRim * pow(1.0 - max(dot(N, V), 0.0), 3.0) * ao * albedo;

  float on = (vM.z > 0.0) ? step(vM.z, uPower) : uPower;
  col += albedo * vM.y * on;

  col += uHi * vec3(1.0, 0.82, 0.35) * (0.22 + 0.12 * sin(uTime * 6.0)) * (0.4 + albedo);   // destaque do que está na mira
  col *= 1.0 - uWet * 0.28;

  float dist = length(uCam - vW);
  float f = 1.0 - exp(-pow(dist * uFogD, 2.0));
  col = mix(col, uFog, f);
  oColor = vec4(col, uAlpha * tx.a);
}`;

/* ---- sombra (apenas profundidade) ---- */
GLSL.shadowVS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uModel, uViewProj;
void main(){ gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;
GLSL.shadowFS = `#version 300 es
precision mediump float; out vec4 o; void main(){ o = vec4(0.0); }`;

/* ---- feixes de luz aditivos (usam a malha da cena) ---- */
GLSL.fxFS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN; in vec3 vC; in vec3 vM; in vec2 vUV;
uniform float uPower; uniform vec3 uTint, uCam;
out vec4 oColor;
void main(){
  float fade = smoothstep(0.8, 2.8, length(uCam - vW));      // some perto da câmera: nada de névoa azul cobrindo a tela
  oColor = vec4(vC * uTint * vM.x * uPower * fade, 1.0);
}`;

/* ---- céu: triângulo de tela cheia, raio reconstruído da base da câmera ---- */
GLSL.fsVS = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;
GLSL.skyFS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 oColor;
uniform vec3 uF, uR, uU; uniform vec2 uTan;
uniform vec3 uHor, uZen, uMoon; uniform float uGlow, uTime, uStars;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main(){
  vec2 n = vUv * 2.0 - 1.0;
  vec3 d = normalize(uF + uR * n.x * uTan.x + uU * n.y * uTan.y);
  float t = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHor, uZen, pow(t, 0.55));
  col += vec3(1.0, 0.55, 0.22) * exp(-abs(d.y) * 7.0) * uGlow * 0.35;       // brilho da cidade no horizonte
  if (d.y < 0.0) col = mix(uHor * 0.5, vec3(0.01, 0.015, 0.03), smoothstep(0.0, -0.3, d.y));
  // estrelas: células de uma grade esférica, com cintilar
  vec3 sp = d * 70.0; vec3 id = floor(sp);
  float r = h21(id.xy + id.z * 17.3);
  float star = step(0.987, r) * smoothstep(0.0, 0.3, d.y);
  vec3 fr = fract(sp) - 0.5; float dd = length(fr);
  col += vec3(0.8, 0.9, 1.0) * star * smoothstep(0.35, 0.0, dd) * (0.6 + 0.4 * sin(uTime * 2.0 + r * 60.0)) * uStars * 2.2;
  // lua facetada + halo (valores > 1 alimentam o bloom)
  float md = dot(d, uMoon);
  float disc = smoothstep(0.9987, 0.9991, md);
  vec3 mb = normalize(cross(uMoon, vec3(0.0, 1.0, 0.0))), mu = cross(mb, uMoon);
  vec2 lp = vec2(dot(d, mb), dot(d, mu)) * 26.0;
  float crater = 0.88 + 0.12 * sin(floor(lp.x * 3.0) * 1.7 + floor(lp.y * 3.0) * 2.3);
  col += vec3(1.0, 0.96, 0.84) * disc * crater * 3.2 + vec3(0.5, 0.62, 0.9) * (pow(max(md, 0.0), 160.0) * 0.55 + pow(max(md, 0.0), 14.0) * 0.07);
  oColor = vec4(col, 1.0);
}`;

/* ---- partículas (pontos com formato hexagonal ou quadrado) ---- */
GLSL.partVS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in float aSize; layout(location=2) in vec4 aCol; layout(location=3) in float aShape;
uniform mat4 uVP; uniform float uScale;
out vec4 vCol; out float vShape;
void main(){
  vec4 c = uVP * vec4(aPos, 1.0);
  gl_Position = c; gl_PointSize = clamp(aSize * uScale / max(c.w, 0.05), 1.0, 220.0);
  vCol = aCol; vShape = aShape;
}`;
GLSL.partFS = `#version 300 es
precision mediump float;
in vec4 vCol; in float vShape; out vec4 oColor;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float a;
  if (vShape < 0.5) { float d = max(abs(p.x) * 0.866 + abs(p.y) * 0.5, abs(p.y)); a = smoothstep(1.0, 0.55, d); }
  else { a = step(max(abs(p.x), abs(p.y)), 0.9); }
  if (a <= 0.0) discard;
  oColor = vec4(vCol.rgb, vCol.a * a);
}`;

/* ---- bloom: pirâmide (downsample 13 taps com Karis + upsample tent) ---- */
GLSL.downFS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 oColor;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uFirst; uniform vec2 uThr;
vec3 prefilter(vec3 c){
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThr.x + uThr.y, 0.0, 2.0 * uThr.y); soft = soft * soft / (4.0 * uThr.y + 1e-4);
  return c * (max(soft, br - uThr.x) / max(br, 1e-4));
}
float karis(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main(){
  vec2 t = uTexel, u = vUv;
  vec3 a = texture(uTex, u + t * vec2(-2.,  2.)).rgb, b = texture(uTex, u + t * vec2(0.,  2.)).rgb, c = texture(uTex, u + t * vec2(2.,  2.)).rgb;
  vec3 d = texture(uTex, u + t * vec2(-2.,  0.)).rgb, e = texture(uTex, u).rgb,                     f = texture(uTex, u + t * vec2(2.,  0.)).rgb;
  vec3 g = texture(uTex, u + t * vec2(-2., -2.)).rgb, h = texture(uTex, u + t * vec2(0., -2.)).rgb, i = texture(uTex, u + t * vec2(2., -2.)).rgb;
  vec3 j = texture(uTex, u + t * vec2(-1.,  1.)).rgb, k = texture(uTex, u + t * vec2(1.,  1.)).rgb;
  vec3 l = texture(uTex, u + t * vec2(-1., -1.)).rgb, m = texture(uTex, u + t * vec2(1., -1.)).rgb;
  vec3 r;
  if (uFirst > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    g0 = prefilter(g0); g1 = prefilter(g1); g2 = prefilter(g2); g3 = prefilter(g3); g4 = prefilter(g4);
    r = (g0 * karis(g0) + g1 * karis(g1) + g2 * karis(g2) + g3 * karis(g3)) * 0.125 + g4 * karis(g4) * 0.5;
    r /= max(0.125 * (karis(g0) + karis(g1) + karis(g2) + karis(g3)) + 0.5 * karis(g4), 1e-4);
  } else {
    r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  oColor = vec4(r, 1.0);
}`;
GLSL.upFS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 oColor;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uK;
void main(){
  vec2 t = uTexel * 1.0; vec3 s = vec3(0.0);
  s += texture(uTex, vUv + t * vec2(-1., -1.)).rgb; s += texture(uTex, vUv + t * vec2(0., -1.)).rgb * 2.0; s += texture(uTex, vUv + t * vec2(1., -1.)).rgb;
  s += texture(uTex, vUv + t * vec2(-1.,  0.)).rgb * 2.0; s += texture(uTex, vUv).rgb * 4.0; s += texture(uTex, vUv + t * vec2(1., 0.)).rgb * 2.0;
  s += texture(uTex, vUv + t * vec2(-1.,  1.)).rgb; s += texture(uTex, vUv + t * vec2(0., 1.)).rgb * 2.0; s += texture(uTex, vUv + t * vec2(1., 1.)).rgb;
  oColor = vec4(s / 16.0 * uK, 1.0);
}`;

/* ---- composição final: bloom + ACES + color grading + vinheta + grão ---- */
GLSL.compFS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 oColor;
uniform sampler2D uScene, uBloom;
uniform float uExposure, uBloomI, uVig, uGrain, uTime, uWarp, uWet, uSat, uHdr;
uniform vec4 uFlash;        // rgb = cor do flash, a = intensidade
uniform vec2 uRes;
vec3 aces(vec3 x){ const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv, cen = uv - 0.5; float r2 = dot(cen, cen);
  uv += cen * sin(sqrt(r2) * 38.0 - uTime * 18.0) * uWarp * 0.012;           // ondulação no choque
  float ca = 0.0007 + r2 * 0.004 + uWarp * 0.01;                              // aberração cromática sutil
  vec3 col = vec3(texture(uScene, uv + cen * ca).r, texture(uScene, uv).g, texture(uScene, uv - cen * ca).b);
  col += texture(uBloom, uv).rgb * uBloomI;
  col *= uExposure;
  col = (uHdr > 0.5) ? aces(col) : clamp(col, 0.0, 1.0);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col * vec3(0.90, 0.98, 1.10), col * vec3(1.07, 1.0, 0.90), smoothstep(0.22, 0.75, l));   // sombras frias, luzes quentes
  col = mix(vec3(l), col, uSat);
  col = mix(col, col * vec3(0.72, 0.9, 1.2), uWet * 0.6);
  col = col * col * (3.0 - 2.0 * col) * 0.35 + col * 0.65;                    // curva em S leve
  col *= 1.0 - smoothstep(0.25, 0.95, r2 * 2.2) * uVig;
  col += uFlash.rgb * uFlash.a;
  col = mix(12.92 * col, 1.055 * pow(max(col, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));  // sRGB exato
  col += (hash(uv * uRes + fract(uTime)) - 0.5) * uGrain * (0.35 + col);        // grão de filme (depois do sRGB, senão estoura nas sombras)
  col += (hash(uv * uRes * 1.7 + 3.1) - 0.5) / 255.0;                          // dither anti-banding
  oColor = vec4(col, 1.0);
}`;

/* ============================== 5. RENDERER ============================== */
class Obj {
  /* Qualquer coisa desenhável: malha + transformação (com pai opcional) + parâmetros de material */
  constructor(mesh, o = {}) {
    this.mesh = mesh; this.parent = o.parent || null;
    this.pos = o.pos ? o.pos.slice() : [0, 0, 0]; this.rot = o.rot ? o.rot.slice() : [0, 0, 0]; this.s = o.s || 1;
    this.visible = true; this.cast = o.cast ?? 0;          // bit0 = sombra da lua, bit1 = sombra da luz de teto
    this.tint = o.tint || [1, 1, 1]; this.power = o.power ?? 1; this.hi = 0; this.spec = o.spec ?? 0.12; this.alpha = o.alpha ?? 1;
    this.map = o.map || null; this.layer = o.layer || 0;   // 0 opaco · 1 transparente · 2 aditivo
    this.ambK = o.ambK ?? 1; this.d1K = o.d1K ?? 1; this.fog = o.fog ?? 1; this.world = M4.ident(); this.fixed = !!o.fixed; this.wet = 0;
    this.update();
  }
  update() {
    M4.compose(this.world, this.pos, this.rot[0], this.rot[1], this.rot[2], this.s);
    if (this.parent) M4.mul(this.world, this.parent.world, this.world);
    return this;
  }
}

class Renderer {
  constructor() {
    this.P = {
      scene: new Program('scene', GLSL.sceneVS, GLSL.sceneFS),
      shadow: new Program('shadow', GLSL.shadowVS, GLSL.shadowFS),
      fx: new Program('fx', GLSL.sceneVS, GLSL.fxFS),
      sky: new Program('sky', GLSL.fsVS, GLSL.skyFS),
      part: new Program('part', GLSL.partVS, GLSL.partFS),
      down: new Program('down', GLSL.fsVS, GLSL.downFS),
      up: new Program('up', GLSL.fsVS, GLSL.upFS),
      comp: new Program('comp', GLSL.fsVS, GLSL.compFS),
    };
    this.P.scene.use().i1('uMap', 0).i1('uSh0', 1).i1('uSh1', 2);
    this.P.comp.use().i1('uScene', 0).i1('uBloom', 1);
    this.quality = 'alta'; this.scale = 1; this.w = 2; this.h = 2;
    this.shadows = [null, null]; this.vp = new Float32Array(16); this.view = new Float32Array(16); this.proj = new Float32Array(16);
    this.vmVP = new Float32Array(16); this.sm = [new Float32Array(16), new Float32Array(16)];
    this.tmp = new Float32Array(16);
    // textura branca 1x1: ocupa a unidade 0 quando o objeto não tem mapa. Sem isso, a textura da cena (ligada na
    // composição do quadro anterior) fica no sampler uMap e forma um "feedback loop" com o framebuffer atual.
    this.white = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.setQuality('alta');
  }

  /* ---- qualidade ---- */
  setQuality(q) {
    this.quality = q;
    const preset = { alta: { sh: 2048, msaa: 4, bloom: 5, maxScale: 1 }, media: { sh: 1024, msaa: 2, bloom: 4, maxScale: 1 }, baixa: { sh: 1024, msaa: 0, bloom: 3, maxScale: 0.8 } }[q];
    this.pre = preset; this.scale = Math.min(this.scale, preset.maxScale);
    this.shadows.forEach(s => s && this.freeShadow(s));
    this.shadows = [this.makeShadow(preset.sh), this.makeShadow(preset.sh)];
    this.resize(true);
  }
  makeShadow(size) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, size };
  }
  freeShadow(s) { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fbo); }

  /* ---- alvos de render (HDR resolvido, MSAA, pirâmide do bloom) ---- */
  resize(force) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.floor(innerWidth * dpr * this.scale)), h = Math.max(200, Math.floor(innerHeight * dpr * this.scale));
    if (!force && w === this.w && h === this.h) return;
    this.w = canvas.width = w; this.h = canvas.height = h;
    this.freeTargets();
    const fmt = HDR ? gl.RGBA16F : gl.RGBA8, type = HDR ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const mkTex = (tw, th) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, tw, th);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const mkFbo = (tex, depthRb) => {
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (depthRb) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      return f;
    };
    this.sceneTex = mkTex(w, h);
    this.msFbo = null; this.sceneFbo = null; this.msaa = 0;
    // MSAA: renderbuffers multisample + blit de resolução (suaviza as arestas duras do low poly)
    if (HDR && this.pre.msaa > 0) {
      try {
        const maxS = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
        const samples = maxS && maxS.length ? Math.min(this.pre.msaa, maxS[0]) : 0;
        if (samples > 1) {
          this.msColor = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.msColor);
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
          this.msDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.msDepth);
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
          this.msFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msColor);
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msDepth);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) { this.msaa = samples; this.sceneFbo = mkFbo(this.sceneTex, null); }
          else { gl.deleteFramebuffer(this.msFbo); this.msFbo = null; }
        }
      } catch (e) { this.msFbo = null; }
    }
    if (!this.msFbo) {
      this.depthRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      this.sceneFbo = mkFbo(this.sceneTex, this.depthRb);
    }
    this.mips = [];
    let mw = w >> 1, mh = h >> 1;
    for (let i = 0; i < this.pre.bloom; i++) {
      mw = Math.max(1, mw); mh = Math.max(1, mh);
      const t = mkTex(mw, mh); this.mips.push({ tex: t, fbo: mkFbo(t, null), w: mw, h: mh });
      mw >>= 1; mh >>= 1;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  freeTargets() {
    if (!this.sceneTex) return;
    gl.deleteTexture(this.sceneTex); if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.msFbo) { gl.deleteFramebuffer(this.msFbo); gl.deleteRenderbuffer(this.msColor); gl.deleteRenderbuffer(this.msDepth); }
    if (this.depthRb) { gl.deleteRenderbuffer(this.depthRb); this.depthRb = null; }
    (this.mips || []).forEach(m => { gl.deleteTexture(m.tex); gl.deleteFramebuffer(m.fbo); });
  }

  /* ---- passes ---- */
  drawList(list, prog, mask, layer) {
    for (const o of list) {
      if (!o.visible || !o.mesh || o.layer !== layer) continue;
      if (mask !== undefined && !(o.cast & mask)) continue;
      prog.m4('uModel', o.world);
      if (!mask && mask !== 0) this.setMaterial(prog, o);
      o.mesh.draw();
    }
  }
  setMaterial(prog, o) {
    prog.f3('uTint', o.tint).f1('uPower', o.power);
    if (prog === this.P.scene) {
      prog.f1('uHi', o.hi).f1('uSpec', o.spec).f1('uAlpha', o.alpha).f1('uWet', o.wet).f1('uAmbK', o.ambK).f1('uD1K', o.d1K);
      if (o.map) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, o.map); prog.f1('uUseMap', 1); } else prog.f1('uUseMap', 0);
    }
  }

  shadowPass(objs, i, mask, env) {
    const s = this.shadows[i], P = this.P.shadow.use();
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo); gl.viewport(0, 0, s.size, s.size);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.0, 3.0);
    P.m4('uViewProj', this.sm[i]);
    for (const o of objs) {
      if (!o.visible || !o.mesh || o.layer !== 0 || !(o.cast & mask)) continue;
      P.m4('uModel', o.world); o.mesh.draw();
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /* Renderiza um quadro completo. scene = {objs, vmObjs, parts:[Particles], env, cam} */
  frame(scene) {
    const { objs, vmObjs, parts, env, cam } = scene, S = this.P.scene, gl_ = gl;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);

    // matrizes de câmera
    const asp = this.w / this.h;
    M4.perspective(this.proj, cam.fov, asp, 0.06, 140);
    M4.lookAt(this.view, cam.pos, V3.add(cam.pos, cam.fwd), [0, 1, 0]);
    M4.mul(this.vp, this.proj, this.view);
    M4.perspective(this.tmp, cam.fov * 0.8, asp, 0.02, 4); M4.mul(this.vmVP, this.tmp, this.view);

    // luzes direcionais com sombra: ortográficas, centradas na sala
    const cen = [0, 1.4, 0];
    [[env.d0, 7.2, 40], [env.d1, 6.6, 30]].forEach(([d, ext, dist], i) => {
      const lv = new Float32Array(16), lp = new Float32Array(16), eye = V3.add(cen, V3.mul(d, dist * 0.5));
      M4.lookAt(lv, eye, cen, Math.abs(d[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0]);
      M4.ortho(lp, -ext, ext, -ext, ext, 0.5, dist); M4.mul(this.sm[i], lp, lv);
      this['texW' + i] = 2 * ext / this.shadows[i].size;
    });
    this.shadowPass(objs, 0, 1, env);
    this.shadowPass(objs, 1, 2, env);

    // --- cena em HDR ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo || this.sceneFbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.depthMask(true); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // céu
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    const th = Math.tan(cam.fov / 2), right = V3.norm(V3.cross(cam.fwd, [0, 1, 0])), up = V3.cross(right, cam.fwd);
    this.P.sky.use().f3('uF', cam.fwd).f3('uR', right).f3('uU', up).f2('uTan', th * asp, th)
      .f3('uHor', env.skyHor).f3('uZen', env.skyZen).f3('uMoon', env.moonDir).f1('uGlow', env.cityGlow).f1('uTime', env.time).f1('uStars', env.stars);
    gl.bindVertexArray(null); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);

    // uniformes globais da cena
    S.use().m4('uViewProj', this.vp).f3('uCam', cam.pos).f3('uSky', env.sky).f3('uGround', env.ground)
      .f3('uD0', env.d0).f3('uC0', env.c0).f3('uD1', env.d1).f3('uC1', env.c1)
      .m4('uSM0', this.sm[0]).m4('uSM1', this.sm[1])
      .f4('uShP', this.texW0, this.texW1, 1 / this.shadows[0].size, 1 / this.shadows[1].size)
      .f3('uFog', env.fog).f1('uFogD', env.fogD).f3('uRim', env.rim).f1('uTime', env.time);
    const n = Math.min(env.pl.length, 8), pa = new Float32Array(32), pc = new Float32Array(24);
    for (let i = 0; i < n; i++) { const l = env.pl[i]; pa.set([l.p[0], l.p[1], l.p[2], l.r], i * 4); pc.set(l.c, i * 3); }
    S.i1('uPLN', n).fv('uPL', pa, 4).fv('uPLC', pc, 3);
    const sp = env.spot;
    S.f1('uSpotOn', sp.on).f3('uSpotP', sp.p).f3('uSpotD', sp.d).f3('uSpotC', sp.c).f2('uSpotCone', sp.cone[0], sp.cone[1]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.shadows[0].tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.shadows[1].tex);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.white);

    this.drawList(objs, S, undefined, 0);                      // opacos
    // viewmodel (ferramenta na mão): faixa de profundidade própria, nunca atravessa paredes
    if (vmObjs.length) {
      gl.depthRange(0, 0.05); S.m4('uViewProj', this.vmVP);
      this.drawList(vmObjs, S, undefined, 0);
      gl.depthRange(0, 1); S.m4('uViewProj', this.vp);
    }
    // transparentes (vidro, poça)
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    this.drawList(objs, S, undefined, 1);
    // feixes de luz aditivos
    gl.blendFunc(gl.ONE, gl.ONE);
    const F = this.P.fx.use().m4('uViewProj', this.vp).f3('uCam', cam.pos);
    this.drawList(objs, F, undefined, 2);
    // partículas
    const PP = this.P.part.use().m4('uVP', this.vp).f1('uScale', this.h / (2 * th));
    for (const ps of parts) {
      if (!ps.n) continue;
      gl.blendFunc(gl.SRC_ALPHA, ps.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      ps.draw();
    }
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.CULL_FACE);

    // resolve MSAA
    if (this.msFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFbo);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // --- bloom ---
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.bindVertexArray(null);
    const useBloom = env.bloom > 0.001 && this.mips.length;
    if (useBloom) {
      const D = this.P.down.use();
      let srcTex = this.sceneTex, sw = this.w, sh = this.h;
      this.mips.forEach((m, i) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, m.fbo); gl.viewport(0, 0, m.w, m.h);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        D.f2('uTexel', 1 / sw, 1 / sh).f1('uFirst', i === 0 ? 1 : 0).f2('uThr', env.bloomThr, 0.5);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        srcTex = m.tex; sw = m.w; sh = m.h;
      });
      const U = this.P.up.use(); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = this.mips.length - 1; i > 0; i--) {
        const src = this.mips[i], dst = this.mips[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex); U.f2('uTexel', 1 / src.w, 1 / src.h).f1('uK', 0.85);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }

    // --- composição na tela ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h);
    const Cm = this.P.comp.use();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, useBloom ? this.mips[0].tex : this.sceneTex);
    gl.activeTexture(gl.TEXTURE0);
    Cm.f1('uExposure', env.exposure).f1('uBloomI', useBloom ? env.bloom : 0).f1('uVig', env.vig).f1('uGrain', env.grain)
      .f1('uTime', env.time).f1('uWarp', env.warp).f1('uWet', env.wetScreen).f1('uSat', env.sat).f1('uHdr', HDR ? 1 : 0)
      .f4('uFlash', env.flash[0], env.flash[1], env.flash[2], env.flash[3]).f2('uRes', this.w, this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/* ============================== 6. PARTÍCULAS ============================= */
/* Simulação na CPU (poucos milhares de partículas), desenho como GL_POINTS.
   Dois sistemas: aditivo (fogo, faíscas, confete brilhante) e alfa (fumaça, água, espuma). */
class Particles {
  constructor(max, additive) {
    this.max = max; this.additive = additive; this.n = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 4); this.c1 = new Float32Array(max * 4);
    this.g = new Float32Array(max); this.drag = new Float32Array(max); this.shape = new Float32Array(max); this.kill = new Uint8Array(max);
    this.buf = new Float32Array(max * 9);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);
    [[0, 3], [1, 1], [2, 4], [3, 1]].forEach(([loc, size], i) => {
      const offs = [0, 3, 4, 8]; gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 36, offs[i] * 4);
    });
    gl.bindVertexArray(null);
  }
  emit(o) {
    if (this.n >= this.max) return; const i = this.n++;
    this.pos.set(o.p, i * 3); this.vel.set(o.v || [0, 0, 0], i * 3);
    this.life[i] = this.maxLife[i] = o.life; this.s0[i] = o.s0; this.s1[i] = o.s1 ?? o.s0;
    this.c0.set(o.c0, i * 4); this.c1.set(o.c1 || [o.c0[0], o.c0[1], o.c0[2], 0], i * 4);
    this.g[i] = o.g || 0; this.drag[i] = o.drag || 0; this.shape[i] = o.shape || 0; this.kill[i] = o.floor ? 1 : 0;
  }
  clear() { this.n = 0; }
  update(dt) {
    for (let i = 0; i < this.n;) {
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3 + 1] -= this.g[i] * dt;
      const k = Math.exp(-this.drag[i] * dt); this.vel[i3] *= k; this.vel[i3 + 1] *= k; this.vel[i3 + 2] *= k;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.life[i] <= 0 || (this.kill[i] && this.pos[i3 + 1] < 0.02)) { this.remove(i); continue; }
      i++;
    }
  }
  remove(i) {
    const l = --this.n; if (i === l) return;
    const cp = (a, k) => { for (let j = 0; j < k; j++) a[i * k + j] = a[l * k + j]; };
    cp(this.pos, 3); cp(this.vel, 3); cp(this.c0, 4); cp(this.c1, 4);
    ['life', 'maxLife', 's0', 's1', 'g', 'drag', 'shape', 'kill'].forEach(k => { this[k][i] = this[k][l]; });
  }
  draw() {
    const b = this.buf;
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.life[i] / this.maxLife[i], o = i * 9, i4 = i * 4;
      b[o] = this.pos[i * 3]; b[o + 1] = this.pos[i * 3 + 1]; b[o + 2] = this.pos[i * 3 + 2];
      b[o + 3] = lerp(this.s0[i], this.s1[i], t);
      for (let c = 0; c < 4; c++) b[o + 4 + c] = lerp(this.c0[i4 + c], this.c1[i4 + c], t);
      b[o + 8] = this.shape[i];
    }
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b, 0, this.n * 9);
    gl.drawArrays(gl.POINTS, 0, this.n);
  }
}

/* ============================ 7. ÁUDIO PROCEDURAL ========================= */
/* Nenhum arquivo de som: tudo é sintetizado com WebAudio (osciladores + ruído filtrado).
   A trilha é um lo-fi gerado em tempo real; o "rádio" da sala toca o MP3 da pasta musica/
   quando existir e, se não existir, reforça a trilha procedural. */
const SFX = (() => {
  let ctx = null, master, sfx, mus, noiseBuf, radioGain;
  const st = { sfxVol: 0.85, musVol: 0.55, muted: false };
  const rnd = (a, b) => a + Math.random() * (b - a);

  function apply() {
    if (!ctx) return;
    master.gain.setTargetAtTime(st.muted ? 0 : 1, ctx.currentTime, 0.05);
    sfx.gain.value = st.sfxVol; mus.gain.value = st.musVol * 0.8;
  }
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4; comp.connect(ctx.destination);
    master = ctx.createGain(); master.connect(comp);
    sfx = ctx.createGain(); sfx.connect(master); mus = ctx.createGain(); mus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    apply(); Music.start(); Ambience.start();
  }

  function tone(f, dur, o = {}) {
    if (!ctx) return; const { type = 'sine', vol = 0.1, slide = 0, at = 0.005, delay = 0, bus = sfx, detune = 0 } = o;
    const t = ctx.currentTime + delay, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f, t); osc.detune.value = detune;
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + at); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(bus); osc.start(t); osc.stop(t + dur + 0.05);
  }
  function filt(type, f, q) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; }
  function noise(dur, o = {}) {
    if (!ctx) return; const { vol = 0.15, hp = 0, lp = 0, bp = 0, q = 1, delay = 0, bus = sfx, at = 0.003 } = o;
    const t = ctx.currentTime + delay, src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = noiseBuf;
    let node = src; const chain = (f) => { node.connect(f); node = f; };
    if (hp) chain(filt('highpass', hp)); if (lp) chain(filt('lowpass', lp)); if (bp) chain(filt('bandpass', bp, q));
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + at); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g); g.connect(bus); src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  /* Laço de ruído filtrado com volume controlável (chuva, extintor, fogo, ventilador) */
  function noiseLoop(o = {}) {
    if (!ctx) return { set() {}, stop() {} };
    const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = noiseBuf; src.loop = true; g.gain.value = 0;
    let node = src; const chain = (f) => { node.connect(f); node = f; };
    if (o.hp) chain(filt('highpass', o.hp)); if (o.lp) chain(filt('lowpass', o.lp)); if (o.bp) chain(filt('bandpass', o.bp, o.q || 1));
    node.connect(g); g.connect(sfx); src.start();
    return { set(v) { g.gain.setTargetAtTime(v, ctx.currentTime, 0.12); }, stop() { try { src.stop(); } catch (e) { } } };
  }
  /* Zumbido elétrico de 50/60 Hz com harmônicos */
  function humLoop(base) {
    if (!ctx) return { set() {} };
    const g = ctx.createGain(); g.gain.value = 0; g.connect(sfx);
    [1, 2, 3, 5].forEach((m, i) => { const o = ctx.createOscillator(); o.type = i ? 'sine' : 'triangle'; o.frequency.value = base * m; const og = ctx.createGain(); og.gain.value = 0.5 / (m * m); o.connect(og); og.connect(g); o.start(); });
    return { set(v) { g.gain.setTargetAtTime(v, ctx.currentTime, 0.2); } };
  }

  const fx = {
    click() { tone(1800, 0.03, { type: 'square', vol: 0.03 }); noise(0.02, { vol: 0.06, hp: 3000 }); },
    pick() { tone(520, 0.08, { type: 'triangle', vol: 0.08 }); tone(780, 0.1, { type: 'triangle', vol: 0.07, delay: 0.06 }); },
    thunk() { tone(140, 0.16, { type: 'sine', vol: 0.22, slide: 0.45 }); noise(0.05, { vol: 0.12, bp: 1400, q: 2 }); tone(2400, 0.02, { type: 'square', vol: 0.03, delay: 0.015 }); },
    breakerOn(n) { fx.thunk(); tone(520 + n * 110, 0.22, { type: 'triangle', vol: 0.09, delay: 0.1 }); },
    trip() { fx.thunk(); tone(90, 0.4, { type: 'sawtooth', vol: 0.09, slide: 0.6, delay: 0.1 }); },
    zap() { noise(0.35, { vol: 0.3, hp: 500, at: 0.001 }); tone(70, 0.3, { type: 'sawtooth', vol: 0.18, slide: 0.5 }); tone(1900, 0.18, { type: 'square', vol: 0.05, slide: 0.3 }); },
    spark() { noise(0.12, { vol: 0.14, hp: 3500, at: 0.001 }); },
    pop() { noise(0.12, { vol: 0.3, hp: 900, at: 0.001 }); tone(220, 0.1, { type: 'square', vol: 0.1, slide: 0.3 }); },
    screw() { for (let i = 0; i < 4; i++) { noise(0.05, { vol: 0.07, bp: 3200, q: 4, delay: i * 0.11 }); tone(900 + i * 40, 0.03, { type: 'square', vol: 0.02, delay: i * 0.11 }); } },
    snip() { noise(0.05, { vol: 0.15, hp: 2500 }); tone(1200, 0.05, { type: 'square', vol: 0.04, slide: 0.5 }); },
    beep(f = 880) { tone(f, 0.12, { type: 'square', vol: 0.05 }); },
    good() { [523, 659, 784].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.1, delay: i * 0.08 })); },
    bad() { tone(220, 0.18, { type: 'square', vol: 0.07 }); tone(165, 0.28, { type: 'square', vol: 0.07, delay: 0.14 }); },
    win() { [523, 659, 784, 1046, 1318].forEach((f, i) => { tone(f, 0.5, { type: 'triangle', vol: 0.11, delay: i * 0.11 }); tone(f * 2, 0.4, { type: 'sine', vol: 0.04, delay: i * 0.11 }); }); },
    lightOn() { tone(180, 0.5, { type: 'sine', vol: 0.12, slide: 3 }); noise(0.3, { vol: 0.06, hp: 4000, delay: 0.1 }); },
    step() { noise(0.07, { vol: rnd(0.04, 0.06), lp: rnd(350, 520) }); },
    door() { noise(0.3, { vol: 0.12, lp: 500 }); tone(110, 0.3, { type: 'triangle', vol: 0.08, slide: 0.7 }); },
    ding() { tone(1320, 0.5, { type: 'sine', vol: 0.09 }); tone(1980, 0.4, { type: 'sine', vol: 0.04, delay: 0.02 }); },
    meow() {
      if (!ctx) return; const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), bp = filt('bandpass', 1300, 3);
      o.type = 'sawtooth'; o.frequency.setValueAtTime(520, t); o.frequency.linearRampToValueAtTime(880, t + 0.16); o.frequency.exponentialRampToValueAtTime(430, t + 0.55);
      bp.frequency.setValueAtTime(900, t); bp.frequency.linearRampToValueAtTime(1900, t + 0.2); bp.frequency.linearRampToValueAtTime(1000, t + 0.55);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.13, t + 0.06); g.gain.linearRampToValueAtTime(0.09, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(bp); bp.connect(g); g.connect(sfx); o.start(t); o.stop(t + 0.65);
    },
    purr() { for (let i = 0; i < 10; i++) noise(0.05, { vol: 0.05, lp: 320, delay: i * 0.07 }); },
  };

  /* ---- ambiente: grilos à noite, de vez em quando ---- */
  const Ambience = {
    on: false, wind: null,
    start() {
      if (this.on || !ctx) return; this.on = true; this.wind = noiseLoop({ lp: 380 }); this.wind.set(0.02);
      const chirp = () => {
        if (!this.on) return; if (ctx.state === 'running' && Ambience.crickets) {
          const n = 2 + (Math.random() * 3 | 0), f = rnd(4100, 4700);
          for (let i = 0; i < n; i++) tone(f, 0.05, { type: 'sine', vol: 0.012, delay: i * 0.07 });
        }
        setTimeout(chirp, rnd(500, 1900));
      };
      chirp();
    }, crickets: true,
  };

  /* ---- trilha lo-fi procedural ---- */
  const Music = {
    timer: null, step: 0, next: 0, mood: 'menu',
    lay: { pad: 0, keys: 0, bass: 0, drums: 0 }, tgt: { pad: 0.5, keys: 0.5, bass: 0, drums: 0 },
    chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60, 64], [48, 52, 55, 59]], roots: [41, 40, 38, 36],
    moods: {
      menu: { pad: 0.55, keys: 0.5, bass: 0, drums: 0 }, dark: { pad: 0.7, keys: 0.12, bass: 0, drums: 0 },
      bright: { pad: 0.35, keys: 0.8, bass: 0.7, drums: 0.5 }, party: { pad: 0.4, keys: 1, bass: 0.9, drums: 0.9 },
    },
    f: m => 440 * Math.pow(2, (m - 69) / 12),
    setMood(m) { this.mood = m; this.tgt = this.moods[m]; },
    start() {
      if (this.timer || !ctx) return; this.next = ctx.currentTime + 0.15;
      this.timer = setInterval(() => this.tick(), 90);
    },
    tick() {
      if (!ctx) return; const bpm = 74, eighth = 60 / bpm / 2;
      for (const k in this.lay) this.lay[k] += (this.tgt[k] - this.lay[k]) * 0.09;
      while (this.next < ctx.currentTime + 0.3) { this.play(this.step, this.next); this.next += eighth * (this.step % 2 ? 1.18 : 0.82); this.step = (this.step + 1) % 32; }
    },
    play(s, t) {
      const bar = (s >> 3) & 3, beat = s & 7, ch = this.chords[bar], L = this.lay, d = ctx.currentTime;
      const note = (m, dur, vol, type, delay) => this.voice(this.f(m), t - d + (delay || 0), dur, vol, type);
      if (beat === 0 && L.pad > 0.02) ch.forEach((m, i) => this.pad(this.f(m - 12 + (i % 2 ? 0 : 0)), t, 2.6, 0.035 * L.pad));
      if (L.keys > 0.02 && [0, 2, 3, 5, 6, 7].includes(beat) && Math.random() < 0.88)
        note(ch[(beat * 3 + (Math.random() * 2 | 0)) % ch.length] + (beat === 6 ? 12 : 0), 0.9, 0.05 * L.keys, 'triangle');
      if (L.bass > 0.02 && (beat === 0 || beat === 4 || (beat === 6 && Math.random() < 0.4))) note(this.roots[bar], 0.55, 0.16 * L.bass, 'sine');
      if (L.drums > 0.02) {
        if (beat === 0 || beat === 4) { tone(135, 0.18, { type: 'sine', vol: 0.18 * L.drums, slide: 0.35, bus: mus, delay: t - d }); }
        if (beat === 2 || beat === 6) noise(0.14, { vol: 0.07 * L.drums, bp: 1900, q: 0.8, bus: mus, delay: t - d });
        if (beat % 2 === 1 || beat === 0) noise(0.03, { vol: 0.03 * L.drums, hp: 7500, bus: mus, delay: t - d });
      }
    },
    voice(f, delay, dur, vol, type) {   // "Rhodes": dois osciladores levemente desafinados com decaimento
      tone(f, dur, { type, vol, bus: mus, delay, at: 0.008 }); tone(f * 2.003, dur * 0.5, { type: 'sine', vol: vol * 0.4, bus: mus, delay, at: 0.005 });
    },
    pad(f, t, dur, vol) {
      const d = t - ctx.currentTime, lp = filt('lowpass', 700); lp.connect(mus);
      [-6, 6].forEach(c => { const o = ctx.createOscillator(), g = ctx.createGain(), tt = ctx.currentTime + d; o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = c;
        g.gain.setValueAtTime(0.0001, tt); g.gain.linearRampToValueAtTime(vol, tt + 0.8); g.gain.exponentialRampToValueAtTime(0.0001, tt + dur); o.connect(g); g.connect(lp); o.start(tt); o.stop(tt + dur + 0.1); });
    },
  };

  /* ---- rádio: MP3 da pasta musica/ (opcional) ---- */
  const Radio = {
    tracks: [], idx: 0, el: null, on: false, status: 'carregando',
    load() {
      const base = new URL('.', location.href);
      if (!/^https?:$/.test(location.protocol)) { this.status = 'indisponível'; return; }
      fetch(new URL('musica/playlist.json', base), { cache: 'no-store' }).then(r => r.json()).then(j => {
        this.tracks = (j.tracks || []).filter(p => typeof p === 'string' && !p.startsWith('/') && !p.includes('..') && /\.(mp3|ogg|wav|m4a|aac|webm)$/i.test(p))
          .map(p => ({ name: p.replace(/\.[^.]+$/, ''), url: new URL('musica/' + p.split('/').map(encodeURIComponent).join('/'), base).href }));
        this.status = this.tracks.length ? 'pronto' : 'vazio';
      }).catch(() => { this.status = 'indisponível'; });
    },
    toggle() {
      this.on = !this.on;
      if (this.tracks.length) {
        if (!this.el) { this.el = new Audio(); this.el.volume = 0.7; this.el.addEventListener('ended', () => this.next(1)); this.el.src = this.tracks[0].url; }
        if (this.on) this.el.play().catch(() => { }); else this.el.pause();
      }
      Music.tgt = this.on && !this.tracks.length ? Music.moods.party : (this.on ? { pad: 0.15, keys: 0.1, bass: 0, drums: 0 } : Music.moods[Music.mood]);
      return this.on;
    },
    next(d) { if (!this.tracks.length) return; this.idx = (this.idx + d + this.tracks.length) % this.tracks.length; this.el.src = this.tracks[this.idx].url; if (this.on) this.el.play().catch(() => { }); },
    pause(p) { if (this.el && this.on) { if (p) this.el.pause(); else this.el.play().catch(() => { }); } },
    setVol(v) { if (this.el) this.el.volume = clamp(v, 0, 1); },
    get name() { return this.tracks.length ? this.tracks[this.idx].name : 'Rádio da casa'; },
  };

  return { init, st, apply, fx, tone, noise, noiseLoop, humLoop, Music, Radio, Ambience, get ctx() { return ctx; },
    setMuted(m) { st.muted = m; apply(); }, setSfx(v) { st.sfxVol = v; apply(); }, setMus(v) { st.musVol = v; apply(); } };
})();

/* ================================ 8. MUNDO ================================ */
const PAL = {
  wall: C(0xd9c8b1), trim: C(0xf2e8d4), wain: C(0x3b7e87), wainDk: C(0x2b5d66), floor: C(0x8a6244), floorDk: C(0x4a3226),
  ceil: C(0xeadfce), beam: C(0x7b4f34), metal: C(0x93a0a9), metalDk: C(0x4a5560), sage: C(0x6f9a90), sageLt: C(0x8bb5aa), slate: C(0x27343a),
  cream: C(0xf4ead2), red: C(0xe0483f), amber: C(0xffb547), teal: C(0x2f9ea0), sky: C(0x6ab7ff), orange: C(0xff8a4a), green: C(0x5fc46a),
  coral: C(0xd95f55), wood: C(0x8b5a3a), woodLt: C(0xbb8758), plant: C(0x57b25a), pot: C(0xc7663c), ink: C(0x1c2238), black: C(0x14171c),
  yellow: C(0xffd23d), white: C(0xf1f4f6), mint: C(0xbfe5d6), plum: C(0x6b4a8a),
};
/* Os cinco disjuntores do quadro. Cada um comanda um aparelho da casa. */
const CIRC = {
  geral: { id: 'geral', nome: 'Geral', art: 'a chave', icon: 'main', col: 0xe8554e },
  luz:   { id: 'luz',   nome: 'Luzes', art: 'as', icon: 'bulb', col: 0xffc247 },
  vent:  { id: 'vent',  nome: 'Ventilador', art: 'o', icon: 'fan', col: 0x47d1c0 },
  gela:  { id: 'gela',  nome: 'Geladeira', art: 'a', icon: 'fridge', col: 0x6cb8ff },
  micro: { id: 'micro', nome: 'Micro-ondas', art: 'o', icon: 'micro', col: 0xff8a4a },
};
const BRANCHES = ['luz', 'vent', 'gela', 'micro'];
const BREAKER_X = { geral: -0.54, luz: -0.27, vent: 0, gela: 0.27, micro: 0.54 };
const hexCss = h => '#' + h.toString(16).padStart(6, '0');

/* ---- pictogramas desenhados em canvas (usados nos rótulos 3D e na interface) ---- */
function drawIcon(g, key, cx, cy, s, col, ink = '#1c2238') {
  g.save(); g.translate(cx, cy); g.scale(s, s); g.lineWidth = 0.085; g.lineJoin = 'round'; g.lineCap = 'round'; g.fillStyle = col; g.strokeStyle = ink;
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  if (key === 'bulb') {
    for (let i = 0; i < 7; i++) { const a = -Math.PI + (i + 0.5) / 7 * Math.PI; g.beginPath(); g.moveTo(Math.cos(a) * 0.5, -0.14 + Math.sin(a) * 0.5); g.lineTo(Math.cos(a) * 0.64, -0.14 + Math.sin(a) * 0.64); g.stroke(); }
    g.beginPath(); g.arc(0, -0.14, 0.3, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#cfd6df'; rr(-0.14, 0.14, 0.28, 0.26, 0.05); g.fill(); g.stroke();
  } else if (key === 'fan') {
    for (let i = 0; i < 4; i++) { g.save(); g.rotate(i * TAU / 4 + 0.35); g.beginPath(); g.ellipse(0, -0.3, 0.14, 0.3, 0, 0, TAU); g.fill(); g.stroke(); g.restore(); }
    g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 0.1, 0, TAU); g.fill(); g.stroke();
  } else if (key === 'fridge') {
    rr(-0.27, -0.45, 0.54, 0.9, 0.08); g.fill(); g.stroke(); g.beginPath(); g.moveTo(-0.27, -0.12); g.lineTo(0.27, -0.12); g.stroke();
    g.beginPath(); g.moveTo(0.14, -0.3); g.lineTo(0.14, -0.2); g.moveTo(0.14, 0); g.lineTo(0.14, 0.14); g.stroke();
  } else if (key === 'micro') {
    rr(-0.46, -0.28, 0.92, 0.56, 0.07); g.fill(); g.stroke(); g.fillStyle = '#26323a'; rr(-0.37, -0.19, 0.5, 0.38, 0.04); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(0.3, -0.08, 0.05, 0, TAU); g.fill(); g.beginPath(); g.arc(0.3, 0.1, 0.05, 0, TAU); g.fill();
  } else if (key === 'main') {
    g.beginPath(); g.arc(0, 0, 0.45, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#fff6c9'; g.beginPath(); g.moveTo(0.1, -0.32); g.lineTo(-0.2, 0.05); g.lineTo(-0.01, 0.05); g.lineTo(-0.1, 0.32); g.lineTo(0.2, -0.07); g.lineTo(0.01, -0.07); g.closePath(); g.fill(); g.stroke();
  } else if (key === 'arrow') {
    g.beginPath(); g.moveTo(-0.5, 0); g.lineTo(0.35, 0); g.stroke(); g.beginPath(); g.moveTo(0.15, -0.2); g.lineTo(0.42, 0); g.lineTo(0.15, 0.2); g.stroke();
  }
  g.restore();
}
const iconCache = {};
function iconURL(key, col) {
  const k = key + col; if (iconCache[k]) return iconCache[k];
  const cv = makeCanvas(128, 128); drawIcon(cv.getContext('2d'), key, 64, 64, 96, col); return (iconCache[k] = cv.toDataURL());
}
function wrapText(g, text, x, y, maxW, lh) {
  let line = ''; for (const w of text.split(' ')) { const t = line + w + ' '; if (g.measureText(t).width > maxW && line) { g.fillText(line.trim(), x, y); line = w + ' '; y += lh; } else line = t; }
  g.fillText(line.trim(), x, y); return y + lh;
}
const FONT_HAND = '"Caveat", "Segoe Print", "Comic Sans MS", cursive', FONT_UI = '"Baloo 2", "Trebuchet MS", sans-serif';

/* Textura dinâmica: um canvas 2D que vira textura (rótulos, bilhetes, telas) */
class CanvasTex {
  constructor(w, h) { this.c = makeCanvas(w, h); this.g = this.c.getContext('2d'); this.tex = texFromCanvas(this.c); }
  upload() {
    gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, this.c); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.generateMipmap(gl.TEXTURE_2D);
  }
}

/* Pistas em três estilos: post-it, quadro branco e desenho de giz de cera */
function paintClue(ct, clue, style) {
  const g = ct.g, w = ct.c.width, h = ct.c.height, m = Math.min(w, h), A = CIRC[clue.a], B = CIRC[clue.b], rnd = mulberry32(clue.a.length * 7 + clue.b.length * 13 + w);
  g.clearRect(0, 0, w, h); g.textBaseline = 'alphabetic'; g.lineCap = 'round'; g.lineJoin = 'round';
  const row = (cy, s, ink, arrow) => { drawIcon(g, A.icon, w * 0.24, cy, s, hexCss(A.col), ink); drawIcon(g, 'arrow', w * 0.5, cy, s * 0.85, arrow, arrow); drawIcon(g, B.icon, w * 0.76, cy, s, hexCss(B.col), ink); };
  const names = (cy, s, size, color) => { g.fillStyle = color; g.font = '700 ' + size + 'px ' + FONT_HAND; g.textAlign = 'center'; g.fillText(A.nome, w * 0.24, cy + s * 0.68); g.fillText(B.nome, w * 0.76, cy + s * 0.68); };
  const wrapLines = (text, maxW) => { const out = []; let line = ''; for (const wd of text.split(' ')) { const t = line + wd + ' '; if (g.measureText(t).width > maxW && line) { out.push(line.trim()); line = wd + ' '; } else line = t; } out.push(line.trim()); return out; };
  // ajusta o texto ao papel: reduz a fonte até caber em maxLines e nunca deixa a última linha passar da borda
  const sentence = (yStart, size, color, maxW, maxLines) => { let fs = size, lines; for (; fs >= size * 0.6; fs -= 2) { g.font = '700 ' + fs + 'px ' + FONT_HAND; lines = wrapLines(clue.short, maxW); if (lines.length <= maxLines) break; }
    g.fillStyle = color; g.textAlign = 'center'; const lh = fs * 1.05, y0 = Math.min(yStart, h * 0.95 - (lines.length - 1) * lh); lines.forEach((t, k) => g.fillText(t, w / 2, y0 + k * lh)); };

  if (style === 'note') {                                     // POST-IT amarelo com dobra no canto e linhas leves
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#fff3a0'); gr.addColorStop(1, '#ffd94f'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, 0, w, 26);                  // faixa adesiva clara no topo
    g.fillStyle = 'rgba(120,80,0,0.16)'; g.beginPath(); g.moveTo(w, h - 64); g.lineTo(w - 64, h); g.lineTo(w, h); g.fill();
    g.strokeStyle = 'rgba(120,90,0,0.13)'; g.lineWidth = 2; for (let y = 120; y < h; y += 46) { g.beginPath(); g.moveTo(22, y); g.lineTo(w - 22, y); g.stroke(); }
    g.fillStyle = '#b8442f'; g.font = '700 42px ' + FONT_HAND; g.textAlign = 'left'; g.fillText(clue.author + ':', 28, 64);
    row(h * 0.34, m * 0.22, '#3a2a14', '#b8442f'); names(h * 0.34, m * 0.22, 34, '#3a2a14'); sentence(h * 0.68, 38, '#2d2110', w * 0.88, 3);
  } else if (style === 'board') {                             // QUADRO BRANCO: marcador azul/vermelho, restos de apagador
    g.fillStyle = '#f7f9fb'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) { g.fillStyle = 'rgba(120,135,160,' + (0.04 + rnd() * 0.05) + ')'; g.beginPath(); g.ellipse(rnd() * w, rnd() * h, 40 + rnd() * 110, 10 + rnd() * 26, rnd() * 3, 0, TAU); g.fill(); }
    g.fillStyle = '#1f3f9a'; g.font = '700 70px ' + FONT_HAND; g.textAlign = 'left'; g.fillText('Recado do ' + clue.author.split(',')[0], 40, 84);
    g.strokeStyle = '#d9382d'; g.lineWidth = 7; g.beginPath(); g.moveTo(40, 104); g.bezierCurveTo(180, 90, 300, 120, 470, 100); g.stroke();
    g.strokeStyle = '#1f3f9a'; g.lineWidth = 5; g.beginPath(); g.arc(w - 90, 70, 34, 0, TAU); g.stroke(); g.beginPath(); g.arc(w - 102, 62, 4, 0, TAU); g.arc(w - 78, 62, 4, 0, TAU); g.stroke(); g.beginPath(); g.arc(w - 90, 74, 18, 0.2, Math.PI - 0.2); g.stroke();
    row(h * 0.45, m * 0.36, '#1f3f9a', '#d9382d'); names(h * 0.45, m * 0.36, 58, '#1f3f9a'); sentence(h * 0.85, 60, '#16306e', w * 0.88, 2);
  } else {                                                    // DESENHO DE CRIANÇA em giz de cera, com moldura rabiscada
    g.fillStyle = '#fff6dc'; g.fillRect(0, 0, w, h);
    const cr = ['#e8554e', '#ffb300', '#2f9ea0', '#7a5ab8', '#4caf50'];
    for (let i = 0; i < 90; i++) { const side = i % 4, t = rnd(), o = 10 + rnd() * 16; g.strokeStyle = cr[i % 5]; g.lineWidth = 4 + rnd() * 3; g.globalAlpha = 0.85;
      g.beginPath(); if (side === 0) { g.moveTo(t * w, o); g.lineTo(t * w + 28, o + rnd() * 6); } else if (side === 1) { g.moveTo(t * w, h - o); g.lineTo(t * w + 28, h - o - rnd() * 6); } else if (side === 2) { g.moveTo(o, t * h); g.lineTo(o + rnd() * 6, t * h + 26); } else { g.moveTo(w - o, t * h); g.lineTo(w - o - rnd() * 6, t * h + 26); } g.stroke(); }
    g.globalAlpha = 1; g.strokeStyle = '#ff9a1f'; g.lineWidth = 6; g.beginPath(); g.arc(w - 120, 72, 22, 0, TAU); g.stroke(); for (let a = 0; a < 8; a++) { g.beginPath(); g.moveTo(w - 120 + Math.cos(a * 0.785) * 30, 72 + Math.sin(a * 0.785) * 30); g.lineTo(w - 120 + Math.cos(a * 0.785) * 44, 72 + Math.sin(a * 0.785) * 44); g.stroke(); }
    g.font = '700 62px ' + FONT_HAND; g.textAlign = 'left'; let x = 100; [...clue.author.split(' (')[0]].forEach((ch, i) => { g.fillStyle = cr[i % 5]; g.fillText(ch, x, 84); x += g.measureText(ch).width; });
    row(h * 0.47, m * 0.34, '#5a3d8a', '#e0652b'); names(h * 0.47, m * 0.34, 40, '#5a3d8a'); sentence(h * 0.86, 37, '#4a2f75', w * 0.84, 2);
  }
  ct.upload();
}

/* ------------------------------------------------------------------------- */
function buildWorld() {
  const W = { objs: [], colliders: [], items: {}, panel: { levers: {}, leds: {}, labels: {} }, notes: {}, lights: {}, toolMeshes: {} };
  const add = o => { W.objs.push(o); return o; };
  const mk = (fn, o = {}) => { const b = new MeshBuilder(o.seed || 5); fn(b); return add(new Obj(b.build(), o)); };
  const meshOf = (fn, seed = 5) => { const b = new MeshBuilder(seed); fn(b); return b.build(); };
  const col = (x, z, w, d) => W.colliders.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  const R = mulberry32(2024);

  /* ============ CASCA DA SALA (paredes, piso, teto): faz sombra da lua ============ */
  const shell = new MeshBuilder(11);
  shell.box(0, -0.16, 0, 8.7, 0.3, 6.7, PAL.floorDk, { j: 0 });
  for (let zi = 0; zi < 20; zi++) {                      // tábuas do assoalho: cor variada por tábua e emendas irregulares
    const z = -3 + 0.15 + zi * 0.3; let x = -4;
    while (x < 4) {
      const len = Math.min(4 - x, 1.3 + R() * 2.4), k = 0.8 + R() * 0.4;
      shell.box(x + len / 2, 0, z, len - 0.018, 0.02, 0.284, dimC(PAL.floor, k), { skip: 'bfklr', j: 0.015 }); x += len;
    }
  }
  const wallC = PAL.wall, T = 0.3;
  shell.box(0, 1.425, -3 - T / 2, 8.6, 3.45, T, wallC, { ao: 1, j: 0 });
  shell.box(0, 1.425, 3 + T / 2, 8.6, 3.45, T, wallC, { ao: 1, j: 0 });
  const sideWall = (sx, hole) => {      // parede lateral com abertura de janela
    const xc = sx * (4 + T / 2), [z0, z1, y0, y1] = hole;
    shell.box(xc, 1.425, (-3 + z0) / 2, T, 3.45, z0 + 3, wallC, { ao: 1, j: 0 });
    shell.box(xc, 1.425, (z1 + 3) / 2, T, 3.45, 3 - z1, wallC, { ao: 1, j: 0 });
    shell.box(xc, (y0 - 0.3) / 2, (z0 + z1) / 2, T, y0 + 0.3, z1 - z0, wallC, { ao: 1, j: 0 });
    shell.box(xc, (y1 + 3.15) / 2, (z0 + z1) / 2, T, 3.15 - y1, z1 - z0, wallC, { ao: 1, j: 0 });
  };
  sideWall(-1, [-1.0, 1.4, 0.95, 2.35]); sideWall(1, [-1.7, -0.1, 1.3, 2.3]);
  shell.box(0, 3.15, 0, 8.6, 0.3, 6.6, PAL.ceil, { ao: 1, j: 0 });
  // faixas de AO "assadas" nos encontros parede/piso e parede/teto (dão peso e profundidade sem custo em runtime)
  const strip = (pts, out, ao) => shell.face(pts, out, PAL.wall, ao);
  [[-4, 'x'], [4, 'x'], [-3, 'z'], [3, 'z']].forEach(([v, ax]) => {
    const e = 0.006 * (v < 0 ? 1 : -1), a = [0.5, 0.5, 1, 1], c = [0.62, 0.62, 1, 1];
    if (ax === 'x') { strip([[v + e, 0, -3], [v + e, 0, 3], [v + e, 0.7, 3], [v + e, 0.7, -3]], [-v, 0, 0], a); strip([[v + e, 3, -3], [v + e, 3, 3], [v + e, 2.5, 3], [v + e, 2.5, -3]], [-v, 0, 0], c); }
    else { strip([[-4, 0, v + e], [4, 0, v + e], [4, 0.7, v + e], [-4, 0.7, v + e]], [0, 0, -v], a); strip([[-4, 3, v + e], [4, 3, v + e], [4, 2.5, v + e], [-4, 2.5, v + e]], [0, 0, -v], c); }
  });
  W.shell = add(new Obj(shell.build(), { cast: 1, fixed: true }));

  /* ============ PROPS ESTÁTICOS (mesa, sofá, bancada, quadro...) ============ */
  const P = new MeshBuilder(21);
  // lambri azul-petróleo + faixa de acabamento
  const wain = (x0, z0, x1, z1, out) => { const L = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(z1 - z0, x1 - x0); P.group({ pos: [(x0 + x1) / 2, 0, (z0 + z1) / 2], ry: -a }, () => { P.box(0, 0.5, 0, L, 1.0, 0.04, PAL.wain, { ao: 0.7, j: 0.02 }); P.box(0, 1.02, 0.005, L, 0.08, 0.07, PAL.trim, { j: 0 }); P.box(0, 0.05, 0.01, L, 0.1, 0.05, PAL.wainDk, { j: 0 }); }); };
  wain(-3.98, -3, -3.98, 3); wain(3.98, -3, 3.98, 3); wain(-4, -2.98, 4, -2.98); wain(-4, 2.98, 4, 2.98);
  // vigas do teto
  [-2, 0.3, 2].forEach(z => P.box(0, 2.9, z, 8, 0.18, 0.22, PAL.beam, { ao: 1, j: 0 }));
  // janela esquerda (grande) e direita: molduras, travessas
  const frame = (sx, z0, z1, y0, y1) => {
    const x = sx * 3.96, zc = (z0 + z1) / 2, hh = (y1 - y0);
    P.box(x, y1, zc, 0.12, 0.08, z1 - z0 + 0.1, PAL.trim, { j: 0 });
    P.box(x - sx * 0.1, y0, zc, 0.34, 0.07, z1 - z0 + 0.16, PAL.trim, { j: 0 });      // peitoril fundo: apoia vasos e objetos
    P.box(x, (y0 + y1) / 2, z0, 0.12, hh, 0.07, PAL.trim, { j: 0 }); P.box(x, (y0 + y1) / 2, z1, 0.12, hh, 0.07, PAL.trim, { j: 0 });
    P.box(x, (y0 + y1) / 2, zc, 0.07, hh, 0.045, PAL.trim, { j: 0 }); P.box(x, (y0 + y1) / 2, zc, 0.07, 0.045, z1 - z0, PAL.trim, { j: 0 });
  };
  frame(-1, -1.0, 1.4, 0.95, 2.35); frame(1, -1.7, -0.1, 1.3, 2.3);
  // cortinas penduradas num varão HORIZONTAL (antes era um poste vertical), com pregas em 3 lâminas
  P.group({ pos: [-3.82, 2.52, 0.2], rx: Math.PI / 2 }, () => P.cyl(0, 0, 0, 0.022, 0.022, 3.3, 6, PAL.metalDk, { ao: 1 }));
  [-1.45, 1.85].forEach(z => P.sphere(-3.82, 2.52, z, 0.05, PAL.amber, { det: 0, ao: 1 }));
  [-1.2, 1.6].forEach(z => { for (let k = 0; k < 3; k++) P.box(-3.84 + (k % 2) * 0.035, 1.42, z + (k - 1) * 0.11, 0.05, 2.15, 0.1, k % 2 ? C(0x2b8c93) : C(0x35a3aa), { ao: 0.85, j: 0.04 }); });
  // peitoril (topo em y = 0.985): vaso e velinha realmente apoiados nele
  P.cyl(-3.84, 1.065, -0.55, 0.11, 0.08, 0.16, 7, PAL.pot); P.sphere(-3.84, 1.27, -0.55, 0.16, PAL.plant, { jit: 0.18, ry: 0.85 }); P.sphere(-3.8, 1.38, -0.48, 0.1, C(0x72c967), { jit: 0.2 });
  P.cyl(-3.84, 1.02, 0.85, 0.045, 0.045, 0.07, 7, PAL.teal); P.cyl(-3.84, 1.065, 0.85, 0.006, 0.006, 0.03, 4, PAL.black);

  /* ---- tapete redondo ---- */
  [[1.3, PAL.coral, 0.006], [1.17, PAL.cream, 0.01], [0.96, C(0x2e7d86), 0.014], [0.5, PAL.cream, 0.018], [0.35, PAL.coral, 0.022]].forEach(([r, c, y]) => P.cyl(-2.4, y, 1.45, r, r, 0.012, 14, c, { ao: 1, j: 0.02 }));

  /* ---- sofá (encosto na parede da porta) ---- */
  P.group({ pos: [-2.4, 0, 2.5] }, () => {
    const c = C(0x2c8c8f), d = C(0x226d70);
    P.box(0, 0.22, 0, 2.0, 0.28, 0.9, d, { ao: 0.5 }); P.box(-0.5, 0.45, -0.07, 0.95, 0.18, 0.72, c); P.box(0.5, 0.45, -0.07, 0.95, 0.18, 0.72, c);
    P.box(0, 0.72, 0.34, 2.0, 0.6, 0.22, c, { ao: 0.6 }); P.box(-1.0, 0.45, 0, 0.18, 0.55, 0.9, d); P.box(1.0, 0.45, 0, 0.18, 0.55, 0.9, d);
    P.group({ pos: [0.62, 0.68, 0.0], rz: -0.25, ry: 0.4 }, () => P.box(0, 0, 0, 0.36, 0.34, 0.1, PAL.amber, { j: 0.06 }));
    P.group({ pos: [-0.7, 0.66, 0.05], rz: 0.2, ry: -0.3 }, () => P.box(0, 0, 0, 0.34, 0.32, 0.1, PAL.coral, { j: 0.06 }));
    [-0.85, 0.85].forEach(x => [-0.35, 0.35].forEach(z => P.box(x, 0.04, z, 0.08, 0.08, 0.08, PAL.wood)));
  });
  col(-2.4, 2.5, 2.0, 0.9);
  // mesinha de centro: centralizada no sofá (x = -2.4), ~2/3 do comprimento, vão de ~40 cm até o assento
  P.group({ pos: [-2.4, 0, 1.37] }, () => {
    P.box(0, 0.4, 0, 1.3, 0.05, 0.6, PAL.woodLt); [[-0.58, -0.24], [0.58, -0.24], [-0.58, 0.24], [0.58, 0.24]].forEach(([x, z]) => P.box(x, 0.19, z, 0.06, 0.38, 0.06, PAL.wood));
    P.box(0, 0.12, 0, 1.2, 0.025, 0.5, PAL.wood);
    P.cyl(-0.38, 0.47, 0.05, 0.04, 0.035, 0.08, 7, PAL.white); P.cyl(0.35, 0.47, -0.08, 0.04, 0.035, 0.08, 7, PAL.coral); P.box(0.0, 0.43, 0.1, 0.24, 0.02, 0.17, C(0xe8dcb8)); P.box(0.0, 0.445, 0.1, 0.2, 0.012, 0.14, PAL.sky);
  });
  col(-2.4, 1.37, 1.3, 0.6);
  // pufe do gato, ao lado do sofá
  P.cyl(-0.85, 0.18, 2.15, 0.3, 0.32, 0.36, 8, PAL.coral); P.cyl(-0.85, 0.37, 2.15, 0.27, 0.3, 0.04, 8, C(0xe57a6f)); col(-0.85, 2.15, 0.64, 0.64);

  /* ---- bancada de trabalho (lado direito) ---- */
  P.group({ pos: [3.62, 0, -0.95] }, () => {
    P.box(0, 0.92, 0, 0.7, 0.08, 2.4, PAL.woodLt, { ao: 0.9 }); P.box(0, 0.3, 0, 0.62, 0.05, 2.3, PAL.wood);
    [-1.12, 1.12].forEach(z => [-0.3, 0.3].forEach(x => P.box(x, 0.45, z, 0.07, 0.9, 0.07, PAL.wood)));
    P.box(0.355, 1.0, 0, 0.02, 0.3, 2.4, C(0xd8cfb8)); // rodapé da bancada (encostado na parede)
    P.box(0, 0.45, -0.8, 0.5, 0.25, 0.4, C(0xa8794a), { ao: 0.6 }); P.box(0, 0.45, 0.5, 0.5, 0.25, 0.6, PAL.metalDk);
  });
  col(3.62, -0.95, 0.7, 2.4);
  // quadro de cortiça com avisos (o bilhete C fica preso aqui, na frente)
  P.box(3.975, 1.6, 0.85, 0.04, 0.78, 1.0, C(0xc79f6a), { ao: 0.95, j: 0.05 });
  [[1.99, 0, 0.06, 1.1], [1.21, 0, 0.06, 1.1]].forEach(([y, , t, w]) => P.box(3.96, y - 0.39 + 0.39, 0.85, 0.06, 0.04, w, PAL.wood, { ao: 1 }));
  [0.3, 1.4].forEach(z => P.box(3.96, 1.6, z, 0.06, 0.82, 0.04, PAL.wood, { ao: 1 }));
  P.box(3.953, 1.78, 0.52, 0.012, 0.14, 0.11, C(0xdfe8f2), { j: 0 }); P.sphere(3.945, 1.84, 0.52, 0.012, PAL.teal, { det: 0, ao: 1 });
  P.box(3.953, 1.42, 1.18, 0.012, 0.12, 0.16, C(0xf0c9d0), { j: 0 }); P.sphere(3.945, 1.47, 1.18, 0.012, PAL.coral, { det: 0, ao: 1 });

  /* ---- cozinha: balcão + prateleira ---- */
  P.group({ pos: [-2.3, 0, -2.7] }, () => {
    P.box(0, 0.42, 0, 1.6, 0.84, 0.58, PAL.cream, { ao: 0.6 }); P.box(0, 0.88, 0, 1.66, 0.06, 0.64, PAL.woodLt);
    [-0.5, 0.5].forEach(x => P.box(x, 0.42, 0.295, 0.7, 0.7, 0.02, C(0xe3d6b8), { ao: 0.9 })); [-0.5, 0.5].forEach(x => P.box(x + 0.28, 0.5, 0.31, 0.03, 0.12, 0.02, PAL.metalDk));
    P.box(0.5, 1.72, -0.12, 1.1, 0.05, 0.3, PAL.wood); P.cyl(0.2, 1.84, -0.12, 0.07, 0.07, 0.2, 7, PAL.teal); P.cyl(0.5, 1.82, -0.12, 0.06, 0.06, 0.16, 7, PAL.amber); P.cyl(0.82, 1.84, -0.12, 0.07, 0.07, 0.2, 7, PAL.coral);
    P.cyl(-0.55, 0.99, 0.02, 0.1, 0.12, 0.14, 7, C(0xc9d2d8)); // panela
  });
  col(-2.3, -2.7, 1.6, 0.6);
  col(-3.55, -2.6, 0.82, 0.78);

  /* ---- armário (luvas): caixa ABERTA na frente (antes era um bloco maciço com uma placa preta) ---- */
  P.group({ pos: [3.72, 0, 1.9] }, () => {
    const out = C(0x7a5a8c), inn = C(0xeadfc6), shelf = PAL.woodLt;
    P.box(0.235, 1.0, 0, 0.03, 2.0, 1.0, out, { ao: 0.7 });
    [-0.485, 0.485].forEach(z => P.box(0, 1.0, z, 0.5, 2.0, 0.03, out, { ao: 0.7 }));
    P.box(0, 1.985, 0, 0.5, 0.03, 1.0, out, { ao: 0.7 }); P.box(0, 0.05, 0, 0.5, 0.1, 1.0, dimC(out, 0.8), { ao: 0.7 });
    P.box(0.215, 1.0, 0, 0.012, 1.9, 0.94, inn, { ao: 0.92, j: 0.02 });                       // forro claro: o interior não fica mais preto
    [-0.455, 0.455].forEach(z => P.box(0, 1.0, z, 0.46, 1.9, 0.012, inn, { ao: 0.92, j: 0.02 }));
    [0.55, 1.05, 1.55].forEach(y => P.box(-0.01, y, 0, 0.44, 0.03, 0.94, shelf, { ao: 0.9 }));
    P.box(-0.02, 1.9, 0, 0.36, 0.02, 0.8, [1, 0.95, 0.8], { ao: 1, em: 0.9, j: 0 });        // lâmpada de LED (a pilha mantém acesa no apagão)
    P.box(0.05, 0.645, -0.28, 0.22, 0.16, 0.3, PAL.cream, { ao: 1 }); P.box(0.05, 0.635, 0.24, 0.22, 0.14, 0.28, PAL.metalDk, { ao: 1 });
    P.box(0.05, 1.125, -0.32, 0.22, 0.12, 0.2, PAL.teal, { ao: 1 }); P.box(0.05, 1.635, 0.1, 0.22, 0.14, 0.3, PAL.red, { ao: 1 }); P.box(0.05, 1.625, -0.3, 0.2, 0.12, 0.2, PAL.amber, { ao: 1 });
  });
  col(3.72, 1.9, 0.55, 1.0);

  /* ---- mesinha do rádio, plantas, pendurados ---- */
  P.group({ pos: [1.7, 0, 2.72] }, () => { P.box(0, 0.7, 0, 0.7, 0.06, 0.45, PAL.woodLt); [[-0.3, -0.18], [0.3, -0.18], [-0.3, 0.18], [0.3, 0.18]].forEach(([x, z]) => P.box(x, 0.34, z, 0.05, 0.68, 0.05, PAL.wood)); P.box(0, 0.25, 0, 0.6, 0.04, 0.38, PAL.wood); });
  col(1.7, 2.72, 0.7, 0.45);
  const plant = (x, z, s) => { P.cyl(x, 0.2 * s, z, 0.2 * s, 0.15 * s, 0.4 * s, 8, PAL.pot); P.sphere(x, 0.65 * s, z, 0.32 * s, PAL.plant, { jit: 0.2, ry: 1.2 }); P.sphere(x + 0.14 * s, 0.95 * s, z - 0.05, 0.2 * s, C(0x6fc766), { jit: 0.22 }); col(x, z, 0.4 * s, 0.4 * s); };
  plant(3.5, 2.75, 1.0); plant(-3.6, -1.55, 0.8);
  // mural de desenhos: papeis nos fundos; texturas carregadas depois (ver loadDrawings)
  // lâmpada de emergência + sinal de saída
  P.box(-0.95, 2.45, 2.95, 0.34, 0.12, 0.08, PAL.white); P.box(0.95, 2.45, 2.95, 0.34, 0.12, 0.08, PAL.white);
  // porta
  P.box(0, 1.08, 2.96, 1.1, 2.16, 0.08, C(0x6b4a3a), { ao: 1, j: 0 }); P.box(0, 1.08, 2.915, 0.8, 0.8, 0.03, C(0x7c5844), { ao: 0.9 }); P.box(0, 0.4, 2.915, 0.8, 0.4, 0.03, C(0x7c5844)); P.box(0, 1.9, 2.915, 0.8, 0.3, 0.03, C(0x7c5844));
  P.box(0.4, 1.0, 2.9, 0.06, 0.06, 0.05, PAL.amber);
  [-0.6, 0.6].forEach(x => P.box(x, 1.1, 2.95, 0.1, 2.2, 0.1, PAL.trim, { j: 0 })); P.box(0, 2.2, 2.95, 1.3, 0.1, 0.1, PAL.trim, { j: 0 });
  // canos dos sprinklers no teto
  [[-2.4, -1.6], [2.4, -1.6], [-2.4, 1.6], [2.4, 1.6]].forEach(([x, z]) => { P.cyl(x, 2.93, z, 0.03, 0.03, 0.12, 6, PAL.red); P.cyl(x, 2.85, z, 0.045, 0.045, 0.04, 6, C(0xe4b94f)); });
  P.box(0, 2.97, -1.6, 4.8, 0.05, 0.05, PAL.red); P.box(0, 2.97, 1.6, 4.8, 0.05, 0.05, PAL.red);
  // conduíte do quadro até o teto
  P.cyl(-0.3, 2.7, -2.96, 0.035, 0.035, 0.7, 6, PAL.metalDk);

  /* ---- QUADRO DE LUZ (corpo estático) ---- */
  P.box(0, 1.55, -2.91, 1.5, 1.65, 0.18, PAL.sage, { ao: 0.75 });
  P.box(0, 1.55, -2.995, 1.62, 1.77, 0.02, PAL.sageLt, { j: 0 });                                   // moldura saliente
  P.box(0, 1.26, -2.812, 1.4, 0.6, 0.012, PAL.slate, { k: 0.5 });                                     // fundo escuro dos disjuntores
  Object.keys(BREAKER_X).forEach(k => P.box(BREAKER_X[k], 1.25, -2.795, 0.22, 0.42, 0.05, PAL.cream, { ao: 0.8, j: 0.02 }));
  P.box(0, 1.77, -2.812, 1.4, 0.3, 0.012, PAL.slate, { k: 0.6 });                                     // fundo das etiquetas
  P.box(0, 2.15, -2.812, 1.3, 0.36, 0.012, PAL.black, { k: 0.06, j: 0 });                             // compartimento dos fusíveis (escuro)
  [[-0.65, 2.15], [0.65, 2.15]].forEach(([x, y]) => P.box(x, y, -2.808, 0.04, 0.38, 0.012, C(0x20282c), { k: 0.1 }));
  P.box(0, 0.86, -2.815, 1.0, 0.15, 0.01, PAL.amber, { j: 0 });                                       // placa inferior
  for (let i = 0; i < 12; i++) P.box(-0.48 + i * 0.087, 0.86, -2.808, 0.04, 0.15, 0.006, PAL.black, { j: 0 });  // listras de aviso
  P.box(0, 0.86, -2.808, 0.0001, 0.0001, 0.0001, PAL.black);
  W.props = add(new Obj(P.build(), { cast: 3, fixed: true }));

  /* ============ OBJETOS DINÂMICOS DO QUADRO ============ */
  // alavancas (pivô no centro; "ligado" = topo para o jogador) + LEDs + etiquetas
  Object.keys(CIRC).forEach(k => {
    const x = BREAKER_X[k], c = C(CIRC[k].col);
    const lev = mk(b => { b.box(0, 0, 0, 0.085, 0.3, 0.05, PAL.metalDk, { ao: 1 }); b.box(0, 0.09, 0.012, 0.1, 0.12, 0.07, c, { ao: 1, j: 0.02 }); b.box(0, -0.09, 0.0, 0.1, 0.12, 0.06, dimC(c, 0.45), { ao: 1, j: 0.02 }); }, { pos: [x, 1.25, -2.755], cast: 3, spec: 0.3 });
    const led = mk(b => b.sphere(0, 0, 0, 0.022, [1, 1, 1], { det: 0, em: 3.2, ao: 1 }), { pos: [x, 1.5, -2.77], tint: [0.4, 1, 0.5], power: 0, cast: 0 });
    const lt = new CanvasTex(256, 200), g = lt.g;
    g.fillStyle = hexCss(CIRC[k].col); g.fillRect(0, 0, 256, 200); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 0, 256, 18);
    drawIcon(g, CIRC[k].icon, 128, 80, 112, '#fff9e8'); g.fillStyle = '#1c2238'; g.font = '800 40px ' + FONT_UI; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(CIRC[k].nome, 128, 168, 236); lt.upload();
    const lab = mk(b => b.plane(0, 0, 0, 0.23, 0.18, [1, 1, 1], { ao: 1 }), { pos: [x, 1.77, -2.803], map: lt.tex, cast: 0 });
    W.panel.levers[k] = lev; W.panel.leds[k] = led; W.panel.labels[k] = lab;
  });
  W.panel.ledMain = mk(b => b.box(0, 0, 0, 0.05, 0.05, 0.02, [1, 1, 1], { em: 3, ao: 1 }), { pos: [0.66, 2.39, -2.815], tint: [1, 0.3, 0.2], power: 0.4 });
  // tampa dos fusíveis (4 parafusos) e fusíveis
  W.panel.cover = mk(b => { b.box(0, 0, 0, 1.32, 0.4, 0.03, C(0x8fa6a4), { ao: 1, j: 0.02 }); [[-0.6, -0.15], [0.6, -0.15], [-0.6, 0.15], [0.6, 0.15]].forEach(([x, y]) => { b.cyl(x, y, 0.025, 0.022, 0.022, 0.02, 6, PAL.metal, { ao: 1 }); b.box(x, y, 0.037, 0.03, 0.006, 0.004, PAL.metalDk, { ao: 1 }); }); b.box(0, 0, 0.018, 0.8, 0.12, 0.004, C(0x6d8886), { ao: 1 }); }, { pos: [0, 2.15, -2.787], cast: 3, spec: 0.35 });
  const fuseMesh = (body, cap, em) => meshOf(b => { b.cyl(0, 0, 0, 0.032, 0.032, 0.17, 8, body, { ao: 1, em: em || 0 }); [0.1, -0.1].forEach(y => b.cyl(0, y, 0, 0.036, 0.036, 0.035, 8, cap, { ao: 1 })); b.box(0, 0.125, 0, 0.03, 0.01, 0.01, PAL.metalDk, { ao: 1 }); });
  W.panel.meshes = { good: fuseMesh(C(0xe5a93a), C(0xc9ced2), 0.3), burnt: fuseMesh(C(0x1d1815), C(0x5a4c40)), fresh: fuseMesh(C(0xffd166), C(0xeef2f5), 0.9) };
  W.panel.fuses = [-0.4, 0, 0.4].map((x, i) => add(new Obj(i === 1 ? W.panel.meshes.burnt : W.panel.meshes.good, { pos: [x, 2.15, -2.785], cast: 0, spec: 0.3 })));
  W.panel.fuseLabels = [-0.4, 0, 0.4].map((x, i) => { const t = new CanvasTex(128, 64); t.g.fillStyle = '#e9e1cd'; t.g.fillRect(0, 0, 128, 64); t.g.fillStyle = '#1c2238'; t.g.font = '800 44px ' + FONT_UI; t.g.textAlign = 'center'; t.g.textBaseline = 'middle'; t.g.fillText('F' + (i + 1), 64, 34); t.upload(); return mk(b => b.plane(0, 0, 0, 0.1, 0.05, [1, 1, 1], { ao: 1 }), { pos: [x, 2.285, -2.805], map: t.tex }); });
  W.panel.fuseLabels.forEach(l => l.visible = false);

  /* ============ FERRAMENTAS (mesmas malhas servem de item no mundo e de "viewmodel") ============ */
  const tm = W.toolMeshes;
  tm.screw = meshOf(b => b.group({ rx: -Math.PI / 2 }, () => { b.cyl(0, -0.02, 0, 0.022, 0.022, 0.12, 8, C(0xff8a3d), { ao: 1 }); b.cyl(0, -0.02, 0, 0.026, 0.026, 0.03, 8, C(0x2c3a46), { ao: 1 }); b.cyl(0, 0.1, 0, 0.007, 0.007, 0.12, 6, PAL.metal, { ao: 1 }); b.box(0, 0.185, 0, 0.0135, 0.05, 0.0045, PAL.metal, { ao: 1, j: 0 }); b.box(0, 0.214, 0, 0.0105, 0.012, 0.0045, C(0xc7d0d6), { ao: 1, j: 0 }); }));
  tm.multi = meshOf(b => { b.box(0, 0, 0, 0.075, 0.125, 0.032, PAL.yellow, { ao: 1 }); b.box(0, 0.025, 0.017, 0.055, 0.036, 0.004, C(0x16301f), { ao: 1, em: 0.9 }); b.cyl(0, -0.02, 0.021, 0.021, 0.021, 0.008, 8, C(0x2c3a46), { ao: 1, rot: 0 }); b.box(-0.02, -0.058, 0.017, 0.012, 0.012, 0.006, PAL.red, { ao: 1 }); b.box(0.02, -0.058, 0.017, 0.012, 0.012, 0.006, PAL.black, { ao: 1 }); });
  tm.pliers = meshOf(b => b.group({ rx: -Math.PI / 2 }, () => { [-1, 1].forEach(s => { b.group({ rz: s * 0.1, pos: [s * 0.012, 0, 0] }, () => { b.box(0, -0.07, 0, 0.022, 0.12, 0.012, s > 0 ? PAL.red : C(0xb83a33), { ao: 1 }); b.box(0, 0.045, 0, 0.018, 0.09, 0.012, PAL.metal, { ao: 1 }); }); }); b.cyl(0, 0, 0, 0.012, 0.012, 0.016, 6, PAL.metalDk, { ao: 1 }); }));
  tm.flash = meshOf(b => b.group({ rx: -Math.PI / 2 }, () => { b.cyl(0, 0, 0, 0.026, 0.026, 0.13, 8, C(0x34414d), { ao: 1 }); b.cyl(0, 0.07, 0, 0.04, 0.03, 0.05, 8, PAL.yellow, { ao: 1 }); b.cyl(0, 0.098, 0, 0.034, 0.034, 0.008, 8, [1, 1, 1], { ao: 1, em: 2.4 }); b.box(0, -0.01, 0.027, 0.012, 0.03, 0.01, PAL.red, { ao: 1 }); }));
  tm.extintor = meshOf(b => { b.cyl(0, 0, 0, 0.065, 0.065, 0.3, 9, PAL.red, { ao: 1 }); b.cyl(0, 0.17, 0, 0.03, 0.065, 0.05, 9, PAL.red, { ao: 1 }); b.cyl(0, 0.21, 0, 0.022, 0.022, 0.04, 6, PAL.black, { ao: 1 }); b.box(0.02, 0.24, 0, 0.1, 0.018, 0.02, PAL.black, { ao: 1 }); b.group({ rz: -0.9, pos: [0.07, 0.15, 0] }, () => b.cyl(0, 0, 0, 0.012, 0.012, 0.16, 6, PAL.black, { ao: 1 })); b.cyl(0, 0.05, 0.066, 0.05, 0.05, 0.002, PAL.white, { ao: 1 }); });
  tm.glove = meshOf(b => { [-1, 1].forEach(s => b.group({ pos: [s * 0.075, 0, 0], ry: s * 0.12 }, () => { b.box(0, 0, 0, 0.09, 0.025, 0.1, PAL.yellow, { ao: 1 }); [-0.032, -0.011, 0.011, 0.032].forEach((x, i) => b.box(x, 0, -0.07 - (i === 1 || i === 2 ? 0.01 : 0), 0.019, 0.022, 0.06, PAL.yellow, { ao: 1 })); b.box(-s * 0.06, 0, -0.01, 0.045, 0.022, 0.02, PAL.yellow, { ao: 1 }); b.box(0, 0, 0.085, 0.1, 0.03, 0.07, C(0x2b6fe0), { ao: 1 }); })); });
  tm.spare = meshOf(b => { b.box(0, 0, 0, 0.14, 0.05, 0.09, PAL.yellow, { ao: 1 }); b.box(0, 0.027, 0, 0.1, 0.004, 0.06, C(0xc98f12), { ao: 1 }); b.group({ rz: Math.PI / 2, pos: [0, 0.075, 0] }, () => { b.cyl(0, 0, 0, 0.022, 0.022, 0.1, 8, C(0xffd166), { ao: 1, em: 0.5 }); [0.055, -0.055].forEach(y => b.cyl(0, y, 0, 0.025, 0.025, 0.02, 8, PAL.metal, { ao: 1 })); }); });
  /* ---- itens da bancada: malhas DEITADAS (eixo maior em x, base em y = 0), pensadas para serem lidas de cima ---- */
  const lay = {};
  const cylX = (b, x0, x1, r0, r1, y, z, seg, c, o = {}) => b.group({ pos: [(x0 + x1) / 2, y, z], rz: -Math.PI / 2 }, () => b.cyl(0, 0, 0, r1, r0, x1 - x0, seg, c, Object.assign({ ao: 1, j: 0.02 }, o)));
  lay.screw = meshOf(b => {                                   // chave de fenda: cabo laranja com anéis, haste de aço, ponta chata
    const y = 0.026, org = C(0xff8a3d), org2 = C(0xd9631f);
    cylX(b, -0.14, -0.12, 0.022, 0.026, y, 0, 10, C(0x22262c)); cylX(b, -0.12, -0.035, 0.026, 0.021, y, 0, 10, org);
    [-0.105, -0.083, -0.061].forEach(x => cylX(b, x - 0.005, x + 0.005, 0.0278, 0.0278, y, 0, 10, org2));
    cylX(b, -0.035, -0.01, 0.016, 0.014, y, 0, 8, C(0x2c3a46)); cylX(b, -0.01, 0.13, 0.0065, 0.0065, y, 0, 6, PAL.metal);
    b.box(0.147, y, 0, 0.034, 0.0125, 0.0035, PAL.metal, { ao: 1, j: 0 });
  }, 31);
  lay.pliers = meshOf(b => {                                  // alicate: duas metades cruzadas no pino, cabos vermelhos emborrachados
    [-1, 1].forEach(sg => b.group({ ry: sg * 0.2 }, () => {
      const yb = sg > 0 ? 0.008 : 0.02, grip = sg > 0 ? PAL.red : C(0xb83a33);
      b.box(-0.07, yb, 0, 0.115, 0.014, 0.03, grip, { ao: 1 }); b.box(-0.135, yb, 0, 0.012, 0.014, 0.034, dimC(grip, 0.7), { ao: 1 });
      b.box(0.065, yb, 0, 0.11, 0.014, 0.024, PAL.metal, { ao: 1 }); b.box(0.125, yb, 0, 0.012, 0.014, 0.016, C(0xc7d0d6), { ao: 1 });
    }));
    b.cyl(0, 0.014, 0, 0.011, 0.011, 0.028, 8, PAL.metalDk, { ao: 1 });
  }, 32);
  lay.multi = meshOf(b => {                                   // multímetro: capa de borracha laranja, visor, seletor, botões e cabos
    b.box(0, 0.017, 0, 0.14, 0.034, 0.078, C(0xe8792a), { ao: 1 }); b.box(0, 0.026, 0, 0.126, 0.02, 0.064, PAL.yellow, { ao: 1 });
    b.box(0.035, 0.0375, 0, 0.056, 0.004, 0.034, C(0x1a2e22), { ao: 1, em: 0.9, j: 0 });
    b.cyl(-0.025, 0.0425, 0, 0.022, 0.022, 0.012, 10, C(0x2a313a), { ao: 1 }); b.box(-0.025, 0.0495, 0, 0.003, 0.002, 0.02, PAL.white, { ao: 1, j: 0 });
    [0.01, 0.032, 0.054].forEach(x => b.box(x, 0.0365, 0.026, 0.014, 0.004, 0.012, C(0x2a313a), { ao: 1 }));
    [[-0.016, PAL.red, 0.2], [0.016, PAL.black, -0.2]].forEach(([z, c, a]) => b.group({ pos: [-0.07, 0.008, z], ry: a }, () => b.box(-0.05, 0, 0, 0.1, 0.006, 0.006, c, { ao: 1, j: 0 })));
  }, 33);
  lay.flash = meshOf(b => {                                   // lanterna: corpo escuro, anéis de pegada, cabeça amarela, lente apagada
    const y = 0.04;
    cylX(b, -0.1, -0.09, 0.028, 0.03, y, 0, 10, C(0x232a31)); cylX(b, -0.09, 0.035, 0.03, 0.03, y, 0, 10, C(0x34414d));
    [-0.065, -0.048, -0.031].forEach(x => cylX(b, x - 0.004, x + 0.004, 0.0318, 0.0318, y, 0, 10, C(0x232a31)));
    cylX(b, 0.035, 0.085, 0.03, 0.042, y, 0, 10, PAL.yellow); cylX(b, 0.085, 0.092, 0.037, 0.037, y, 0, 10, [0.8, 0.86, 0.92], { em: 0 });
    b.box(-0.01, y + 0.031, 0, 0.03, 0.01, 0.015, PAL.red, { ao: 1 });
  }, 34);
  lay.fuse = meshOf(b => {                                    // fusível: só o cartucho (vidro âmbar + tampas metálicas + filamento)
    const y = 0.02; cylX(b, -0.03, 0.03, 0.017, 0.017, y, 0, 10, C(0xd98e1f), { em: 0.12 });
    [-0.036, 0.036].forEach(x => cylX(b, x - 0.008, x + 0.008, 0.02, 0.02, y, 0, 10, C(0xd7dce0)));
    b.box(0, y + 0.0172, 0, 0.055, 0.002, 0.004, C(0x3a2a1a), { ao: 1, j: 0 });
  }, 35);
  const TOP = 0.962, bi = (key, z, x, yaw, s) => (W.items[key] = add(new Obj(lay[key === 'spare' ? 'fuse' : key], { pos: [x, TOP, z], rot: [0, -Math.PI / 2 + yaw, 0], s, cast: 3, spec: 0.3 })));
  bi('screw', -1.85, 3.56, 0.12, 1.7); bi('pliers', -1.38, 3.56, -0.18, 1.7); bi('multi', -0.85, 3.56, Math.PI + 0.1, 1.7); bi('spare', -0.42, 3.56, -0.15, 2.2); bi('flash', 0.0, 3.56, 0.16, 1.7);
  W.items.glove = add(new Obj(tm.glove, { pos: [3.7, 1.085, 1.9], rot: [0, Math.PI / 2, 0], s: 1.6, cast: 0 }));
  // extintor fixo na parede (pegável)
  const extBody = mk(b => { b.box(0, 0, -0.02, 0.26, 0.6, 0.02, C(0xd5c9b0), { ao: 1 }); b.group({ pos: [0, 0.0, 0.08] }, () => { b.cyl(0, 0, 0, 0.09, 0.09, 0.48, 9, PAL.red, { ao: 1 }); b.cyl(0, 0.28, 0, 0.04, 0.09, 0.06, 9, PAL.red, { ao: 1 }); b.cyl(0, 0.33, 0, 0.03, 0.03, 0.05, 6, PAL.black, { ao: 1 }); b.box(0.03, 0.37, 0, 0.14, 0.02, 0.03, PAL.black, { ao: 1 }); b.cyl(0, 0.05, 0.092, 0.07, 0.07, 0.003, PAL.white, { ao: 1 }); b.box(0, 0.12, 0.1, 0.1, 0.02, 0.005, PAL.metalDk, { ao: 1 }); b.group({ rz: 1.0, pos: [0.14, 0.18, 0] }, () => b.cyl(0, 0, 0, 0.016, 0.016, 0.24, 6, PAL.black, { ao: 1 })); }); }, { pos: [3.38, 1.1, -2.94], cast: 3, spec: 0.3 });
  W.items.extintor = extBody;
  mk(b => b.plane(0, 0, 0, 0.3, 0.22, [1, 1, 1], { ao: 1 }), { pos: [3.38, 1.62, -2.985], map: (() => { const t = new CanvasTex(256, 190); t.g.fillStyle = '#d83a32'; t.g.fillRect(0, 0, 256, 190); t.g.fillStyle = '#fff'; t.g.font = '800 46px ' + FONT_UI; t.g.textAlign = 'center'; t.g.fillText('EXTINTOR', 128, 74); t.g.font = '700 28px ' + FONT_UI; t.g.fillText('CO₂ · fogo elétrico', 128, 118); t.g.fillText('puxe e aponte', 128, 154); t.upload(); return t.tex; })() });

  /* ============ PISTAS: cada uma é um objeto físico reconhecível ============ */
  // a = desenho do Pedrinho preso à geladeira com ímãs · b = quadro branco com moldura e porta-pincéis · c = post-it com alfinete na cortiça
  const noteDefs = { a: { style: 'kid', w: 0.52, h: 0.39, tex: [512, 384] }, b: { style: 'board', w: 1.2, h: 0.84, tex: [800, 560] }, c: { style: 'note', w: 0.34, h: 0.34, tex: [384, 384] } };
  const noteObj = (id, pos, rot) => {
    const d = noteDefs[id], ct = new CanvasTex(d.tex[0], d.tex[1]);
    const magnet = (b, x, y, c) => b.group({ pos: [x, y, 0.012], rx: Math.PI / 2 }, () => b.cyl(0, 0, 0, 0.024, 0.024, 0.014, 8, c, { ao: 1, j: 0 }));
    const root = mk(b => {
      if (id === 'a') { b.box(0.012, -0.012, -0.002, d.w, d.h, 0.003, dimC(PAL.mint, 0.5), { ao: 1, j: 0 }); magnet(b, -0.19, 0.14, PAL.red); magnet(b, 0.19, 0.14, PAL.teal); }
      if (id === 'b') {
        b.box(0, 0, -0.008, d.w + 0.08, d.h + 0.08, 0.03, C(0x8d98a3), { ao: 1, j: 0 });                         // moldura de alumínio
        b.box(0, -(d.h / 2 + 0.065), 0.025, 0.9, 0.03, 0.07, C(0x7d8893), { ao: 1, j: 0 });                       // porta-pincéis
        [[-0.2, PAL.red], [-0.05, C(0x2b5fd6)], [0.12, PAL.black]].forEach(([x, c]) => b.group({ pos: [x, -(d.h / 2 + 0.04), 0.05], rz: Math.PI / 2 }, () => b.cyl(0, 0, 0, 0.013, 0.013, 0.13, 6, c, { ao: 1, j: 0 })));
        magnet(b, 0.54, 0.38, PAL.red); magnet(b, -0.54, -0.36, PAL.teal);
      }
      if (id === 'c') { b.box(0.01, -0.012, -0.002, d.w, d.h, 0.003, C(0x6b5a2a), { ao: 1, j: 0 }); b.sphere(0.115, 0.14, 0.016, 0.02, PAL.red, { det: 0, ao: 1, j: 0 }); b.box(0.115, 0.14, 0.004, 0.006, 0.006, 0.02, PAL.metal, { ao: 1, j: 0 }); }
    }, { pos, rot, cast: 0 });
    const face = mk(b => b.plane(0, 0, 0, id === 'b' ? d.w - 0.02 : d.w, id === 'b' ? d.h - 0.02 : d.h, [1, 1, 1], { ao: 1 }), { parent: root, pos: [0, 0, id === 'b' ? 0.009 : 0.004], map: ct.tex, cast: 0 });
    return { obj: root, face, ct, style: d.style };
  };
  W.notes.a = noteObj('a', [0.4, 1.54, 0.066], [0, 0, 0.05]);                    // o pai (porta da geladeira) é definido depois
  W.notes.b = noteObj('b', [2.2, 1.8, -2.968], [0, 0, 0]);
  W.notes.c = noteObj('c', [3.944, 1.6, 0.86], [0, -Math.PI / 2, -0.05]);
  W.sticker = (() => {
    const t = new CanvasTex(256, 192), g = t.g; g.fillStyle = '#fff2c4'; g.fillRect(0, 0, 256, 192); g.strokeStyle = '#e8554e'; g.lineWidth = 6; g.strokeRect(8, 8, 240, 176);
    drawIcon(g, 'main', 128, 62, 90, '#e8554e'); g.fillStyle = '#1c2238'; g.font = '800 30px ' + FONT_UI; g.textAlign = 'center'; g.fillText('GERAL liga', 128, 134); g.fillText('sempre primeiro', 128, 166); t.upload();
    mk(b => { b.box(0.008, -0.01, -0.004, 0.3, 0.225, 0.003, C(0x3b4552), { ao: 1, j: 0 }); b.box(0, 0.118, 0.004, 0.1, 0.03, 0.004, [1, 1, 1], { ao: 1, j: 0 }); }, { pos: [-1.12, 1.5, -2.985], cast: 0 });
    return mk(b => b.plane(0, 0, 0, 0.3, 0.225, [1, 1, 1], { ao: 1 }), { pos: [-1.12, 1.5, -2.978], map: t.tex, cast: 0 });
  })();
  mk(b => { b.box(0, 0, 0, 0.5, 0.36, 0.015, C(0xf1e7d4), { j: 0 }); b.box(0, 0.12, 0.01, 0.5, 0.1, 0.006, PAL.coral, { j: 0 }); for (let i = 0; i < 12; i++) b.box(-0.2 + (i % 4) * 0.13, 0.05 - Math.floor(i / 4) * 0.08, 0.01, 0.07, 0.04, 0.004, C(0xd9d1be), { j: 0.05 }); }, { pos: [-1.55, 2.3, -2.985], cast: 0 });

  /* ============ ARMÁRIO: portas dinâmicas ============ */
  const cabDoor = (z, dir) => mk(b => { b.box(-0.01, 0, dir * 0.235, 0.03, 1.9, 0.47, C(0x8a68a0), { ao: 0.9 }); b.box(-0.03, -0.02, dir * 0.4, 0.025, 0.2, 0.025, PAL.metal, { ao: 1 }); b.box(-0.025, 0, dir * 0.235, 0.012, 1.5, 0.35, C(0x9a78b0), { ao: 1, j: 0.02 }); }, { pos: [3.455, 1.0, z], cast: 3 });
  W.cabinet = { doorL: cabDoor(1.42, 1), doorR: cabDoor(2.38, -1) };

  /* ============ GELADEIRA (porta dinâmica) ============ */
  mk(b => { b.box(0, 0.88, 0, 0.8, 1.76, 0.75, PAL.mint, { ao: 0.7, j: 0.02 }); b.box(0, 0.12, 0.4, 0.8, 0.2, 0.02, C(0x9cc9ba), { ao: 1 }); b.box(0.2, 1.8, 0.1, 0.38, 0.06, 0.4, C(0x9cc9ba), { ao: 1 }); }, { pos: [-3.55, 0, -2.6], cast: 3 });
  W.fridge = {};
  W.fridge.inside = mk(b => { b.box(0.4, 0.88, 0, 0.74, 1.66, 0.04, C(0xe9f2f7), { ao: 1, em: 1.1, j: 0 }); [0.35, 0.8, 1.25].forEach(y => b.box(0.4, y, 0.14, 0.7, 0.025, 0.2, C(0xcfe3ee), { ao: 1, j: 0 })); b.box(0.3, 0.55, 0.16, 0.14, 0.2, 0.1, PAL.coral, { ao: 1 }); b.box(0.5, 1.05, 0.16, 0.16, 0.14, 0.1, PAL.yellow, { ao: 1 }); b.box(0.2, 1.4, 0.16, 0.1, 0.16, 0.1, PAL.green, { ao: 1 }); }, { pos: [-3.95, 0, -2.36], power: 0, cast: 0 });
  W.fridge.door = mk(b => { b.box(0.4, 0.88, 0.03, 0.8, 1.76, 0.06, PAL.mint, { ao: 0.85, j: 0.02 }); b.box(0.72, 1.0, 0.09, 0.03, 0.5, 0.04, PAL.metal, { ao: 1 }); b.box(0.4, 1.3, 0.065, 0.8, 0.02, 0.01, C(0x9cc9ba), { ao: 1 }); [[0.2, 0.5, PAL.coral], [0.3, 0.3, PAL.teal]].forEach(([x, y, c]) => b.box(x, y + 0.7, 0.07, 0.04, 0.04, 0.02, c, { ao: 1 })); }, { pos: [-3.95, 0, -2.2], cast: 3 });
  W.fridge.hum = 0;
  // pista A: presa na porta da geladeira
  W.notes.a.obj.parent = W.fridge.door;
  col(-3.55, -2.6, 0.82, 0.78);

  /* ============ MICRO-ONDAS ============ */
  W.micro = {};
  mk(b => { b.box(0, 0.14, 0, 0.5, 0.28, 0.36, C(0xc9d1d8), { ao: 0.9, j: 0.02 }); b.box(0.19, 0.14, 0.185, 0.1, 0.24, 0.01, C(0x39444d), { ao: 1, j: 0 }); [0.06, 0.12, 0.18, 0.22].forEach(y => b.box(0.19, y - 0.02, 0.192, 0.07, 0.014, 0.006, PAL.metal, { ao: 1 })); }, { pos: [-2.3, 0.91, -2.72], cast: 3 });
  W.micro.inner = mk(b => { b.box(-0.05, 0.14, 0, 0.36, 0.22, 0.3, C(0xfff0c8), { ao: 1, em: 1.6, j: 0, skip: 'f' }); b.cyl(-0.05, 0.05, 0, 0.12, 0.12, 0.012, 10, PAL.white, { ao: 1 }); b.cyl(-0.05, 0.075, 0, 0.04, 0.04, 0.05, 6, PAL.coral, { ao: 1 }); }, { pos: [-2.3, 0.91, -2.72], power: 0, cast: 0 });
  W.micro.plate = mk(b => { b.cyl(0, 0, 0, 0.12, 0.12, 0.012, 10, PAL.white, { ao: 1 }); b.cyl(0, 0.03, 0.0, 0.035, 0.035, 0.06, 6, PAL.coral, { ao: 1 }); b.box(0.06, 0.035, 0.03, 0.03, 0.05, 0.03, PAL.amber, { ao: 1 }); }, { pos: [-2.35, 0.965, -2.72], cast: 0 });
  W.micro.display = mk(b => b.box(0, 0, 0, 0.075, 0.035, 0.008, [0.3, 1, 0.5], { ao: 1, em: 2.2, j: 0 }), { pos: [-2.11, 1.06, -2.525], power: 0, cast: 0 });
  W.micro.door = mk(b => { b.box(0.18, 0, 0.01, 0.36, 0.26, 0.025, C(0x39444d), { ao: 1, j: 0 }); b.box(0.34, 0, 0.03, 0.02, 0.18, 0.02, PAL.metal, { ao: 1 }); }, { pos: [-2.55, 1.05, -2.53], cast: 0 });
  W.micro.glass = mk(b => b.box(0.17, 0, 0.012, 0.28, 0.19, 0.01, C(0x121a20), { ao: 1, j: 0 }), { parent: W.micro.door, pos: [0, 0, 0.012], layer: 1, alpha: 0.5, cast: 0 });

  /* ============ VENTILADOR DE TETO ============ */
  mk(b => { b.cyl(0, 0.2, 0, 0.025, 0.025, 0.4, 6, PAL.metalDk, { ao: 1 }); b.cyl(0, -0.02, 0, 0.12, 0.14, 0.08, 8, PAL.metalDk, { ao: 1 }); }, { pos: [0.3, 2.78, 0.2], cast: 3 });
  W.fan = mk(b => { for (let i = 0; i < 4; i++) b.group({ ry: i * TAU / 4 }, () => { b.box(0.52, 0, 0, 0.68, 0.015, 0.17, i % 2 ? C(0xb6844f) : C(0xc4935c), { ao: 1, j: 0.03 }); b.box(0.2, 0, 0, 0.12, 0.02, 0.05, PAL.metalDk, { ao: 1 }); }); b.cyl(0, -0.04, 0, 0.08, 0.1, 0.06, 8, PAL.amber, { ao: 1 }); }, { pos: [0.3, 2.7, 0.2], cast: 3 });

  /* ============ LUMINÁRIAS (pendentes + de chão) ============ */
  const pendant = (x, y, z, c) => mk(b => { b.cyl(0, (3 - y) / 2 + 0.06, 0, 0.008, 0.008, 3 - y + 0.1, 4, PAL.black, { ao: 1 }); b.cyl(0, 0.0, 0, 0.05, 0.22, 0.2, 9, c, { ao: 1, em: 0.55, j: 0.02, open: true }); b.cyl(0, 0.1, 0, 0.05, 0.05, 0.04, 6, PAL.metalDk, { ao: 1 }); b.sphere(0, -0.06, 0, 0.065, [1, 0.92, 0.7], { det: 1, em: 4.5, ao: 1, j: 0 }); }, { pos: [x, y, z], power: 0, cast: 0 });
  W.lamps = [pendant(-1.3, 2.05, -0.2, C(0xff9a4d)), pendant(1.9, 2.05, 0.9, C(0xff7a6a))];
  W.floorLamp = mk(b => { b.cyl(0, 0.02, 0, 0.14, 0.14, 0.04, 8, PAL.metalDk, { ao: 1 }); b.cyl(0, 0.8, 0, 0.012, 0.012, 1.55, 5, PAL.metalDk, { ao: 1 }); b.cyl(0, 1.58, 0, 0.12, 0.2, 0.28, 8, C(0xffd9a0), { ao: 1, em: 1.1, j: 0.02, open: true }); b.sphere(0, 1.55, 0, 0.06, [1, 0.92, 0.7], { det: 1, em: 4, ao: 1, j: 0 }); }, { pos: [-3.62, 0, 2.45], power: 0, cast: 0 });
  col(-3.62, 2.45, 0.3, 0.3);
  // placa "SAÍDA" + luz de emergência
  const exitT = new CanvasTex(256, 96); exitT.g.fillStyle = '#17a35a'; exitT.g.fillRect(0, 0, 256, 96); exitT.g.fillStyle = '#eafff3'; exitT.g.font = '800 62px ' + FONT_UI; exitT.g.textAlign = 'center'; exitT.g.textBaseline = 'middle'; exitT.g.fillText('SAÍDA', 128, 52); exitT.upload();
  W.exitSign = mk(b => { b.box(0, 0, 0, 0.42, 0.16, 0.05, PAL.white, { ao: 1, j: 0 }); b.plane(0, 0, 0.0255, 0.38, 0.13, [1.4, 1.4, 1.4], { ao: 1 }); }, { pos: [0, 2.42, 2.945], rot: [0, Math.PI, 0], cast: 0 });
  W.exitSign.mesh = meshOf(b => { b.box(0, 0, 0, 0.42, 0.16, 0.05, PAL.white, { ao: 1, j: 0 }); });
  W.exitFace = mk(b => b.plane(0, 0, 0, 0.38, 0.13, [1, 1, 1], { ao: 1, em: 0 }), { pos: [0, 2.42, 2.918], rot: [0, Math.PI, 0], map: exitT.tex, cast: 0 });
  W.emergLed = mk(b => b.sphere(0, 0, 0, 0.035, [1, 0.2, 0.15], { det: 0, em: 4, ao: 1, j: 0 }), { pos: [-0.95, 2.45, 2.9], power: 1, cast: 0 });

  /* ============ RÁDIO ============ */
  W.radio = {};
  W.radio.body = mk(b => { b.box(0, 0, 0, 0.5, 0.26, 0.17, C(0x2d4b53), { ao: 0.9, j: 0.02 }); b.box(0, 0.0, -0.088, 0.46, 0.22, 0.01, C(0x3a606a), { ao: 1, j: 0 }); b.cyl(-0.12, 0, -0.1, 0.075, 0.075, 0.012, 10, C(0x151a1d), { ao: 1 }); b.group({ rx: -Math.PI / 2, pos: [-0.12, 0, -0.1] }, () => { }); b.box(0.1, 0.0, -0.1, 0.2, 0.06, 0.004, C(0x0f1a14), { ao: 1, j: 0 }); b.cyl(0.07, -0.07, -0.1, 0.022, 0.022, 0.02, 7, PAL.amber, { ao: 1 }); b.cyl(0.19, -0.07, -0.1, 0.016, 0.016, 0.02, 7, PAL.metal, { ao: 1 }); b.group({ rz: -0.5, pos: [0.2, 0.2, 0.04] }, () => b.cyl(0, 0, 0, 0.005, 0.005, 0.3, 4, PAL.metal, { ao: 1 })); b.box(0, 0.15, 0, 0.3, 0.025, 0.04, C(0x1e3238), { ao: 1 }); }, { pos: [1.7, 0.865, 2.74], rot: [0, 0, 0], cast: 3 });
  W.radio.screen = mk(b => b.box(0, 0, 0, 0.19, 0.05, 0.004, [0.45, 1, 0.65], { ao: 1, em: 1.4, j: 0 }), { pos: [1.7 + 0.1, 0.865, 2.74 - 0.1], power: 0.12, cast: 0 });
  W.radio.screen.pos[0] = 1.8; W.radio.screen.pos[2] = 2.64;

  /* ============ GATO (Fusível) ============ */
  const cat = W.cat = { root: new Obj(null, { pos: [-0.85, 0.38, 2.15] }) };
  const OR = C(0xf08a3c), OD = C(0xc9631f), WH = C(0xfaf2e6), PK = C(0xf2a1a8);
  add(cat.root);
  cat.body = mk(b => { b.sphere(0, 0.14, 0, 0.17, OR, { det: 1, ry: 1.05, jit: 0.04 }); b.box(0, 0.2, 0.0, 0.2, 0.03, 0.2, OD, { ao: 1, j: 0 }); b.sphere(0, 0.1, -0.12, 0.1, WH, { det: 1, ry: 1.2 }); [-1, 1].forEach(s => b.box(s * 0.07, 0.025, -0.14, 0.07, 0.05, 0.1, WH)); b.sphere(0, 0.06, 0.15, 0.11, OD, { det: 1 }); }, { parent: cat.root, cast: 3 });
  cat.head = mk(b => { b.sphere(0, 0, 0, 0.115, OR, { det: 1, ry: 0.92, jit: 0.04 }); [-1, 1].forEach(s => { b.group({ pos: [s * 0.075, 0.1, 0.0], rz: -s * 0.25 }, () => { b.cone(0, 0, 0, 0.05, 0.11, 4, OR, { ao: 1 }); b.cone(0, -0.01, -0.012, 0.03, 0.07, 4, PK, { ao: 1 }); }); b.box(s * 0.045, -0.035, -0.09, 0.06, 0.05, 0.05, WH); }); b.box(0, -0.03, -0.113, 0.03, 0.022, 0.015, PK, { ao: 1, j: 0 }); [-0.045, 0.045].forEach(x => b.box(x, 0.075, -0.07, 0.012, 0.012, 0.01, OD, { ao: 1, j: 0 })); }, { parent: cat.root, pos: [0, 0.34, -0.1], cast: 3 });
  cat.eyes = [-0.047, 0.047].map(x => mk(b => b.sphere(0, 0, 0, 0.02, [0.55, 0.9, 0.35], { det: 0, em: 1.3, ao: 1, j: 0 }), { parent: cat.head, pos: [x, 0.012, -0.095] }));
  cat.pupils = [-0.047, 0.047].map(x => mk(b => b.box(0, 0, 0, 0.007, 0.028, 0.004, PAL.black, { ao: 1, j: 0 }), { parent: cat.head, pos: [x, 0.012, -0.116] }));
  cat.tail = []; let par = cat.root;
  for (let i = 0; i < 4; i++) { const t = mk(b => { b.box(0, 0.045, 0, 0.055 - i * 0.006, 0.1, 0.055 - i * 0.006, i === 3 ? WH : (i % 2 ? OD : OR), { ao: 1, j: 0.02 }); }, { parent: par, pos: i === 0 ? [0.04, 0.09, 0.2] : [0, 0.092, 0], rot: i === 0 ? [0.9, 0, 0.4] : [0, 0, 0.2], cast: 3 }); cat.tail.push(t); par = t; }
  W.catAABB = { min: [-1.15, 0.35, 1.85], max: [-0.55, 0.85, 2.4] };

  /* ============ FEIXES DE LUAR, VIDRO E POÇA ============ */
  const sh = new MeshBuilder(3), Lm = [-0.75, 0.46, 0.3], tv = V3.norm(V3.mul(Lm, -1));  // sentido de propagação da luz
  for (let i = 0; i < 7; i++) {
    const z = -0.85 + i * 0.32, a = 0.5 * (1 - Math.abs(i - 3) / 4.5), y0 = 1.0, y1 = 2.3, L = 4.2;
    const A = [-4.02, y0, z], B = [-4.02, y1, z], Cc = V3.add(B, V3.mul(tv, L)), Dd = V3.add(A, V3.mul(tv, L));
    sh.quad(A, B, Cc, Dd, [1, 0, 0], [1, 1, 1], [0.9 * a, 0.9 * a, 0, 0]);
    sh.quad(A, [A[0], A[1], z + 0.3], V3.add([A[0], A[1], z + 0.3], V3.mul(tv, L)), Dd, [0, 1, 0], [1, 1, 1], [0.5 * a, 0.5 * a, 0, 0]);
  }
  W.shafts = add(new Obj(sh.build(), { layer: 2, tint: [0.3, 0.42, 0.9], power: 0.3 }));
  W.glass = [mk(b => b.box(-3.99, 1.65, 0.2, 0.02, 1.4, 2.4, [0.6, 0.85, 1], { j: 0, ao: 1 }), { layer: 1, alpha: 0.1, cast: 0 }), mk(b => b.box(3.99, 1.8, -0.9, 0.02, 1.0, 1.6, [0.6, 0.85, 1], { j: 0, ao: 1 }), { layer: 1, alpha: 0.1, cast: 0 })];
  W.puddle = mk(b => b.quad([-3.9, 0.025, -2.9], [-3.9, 0.025, 2.9], [3.9, 0.025, 2.9], [3.9, 0.025, -2.9], [0, 1, 0], [0.25, 0.55, 0.9], 1), { layer: 1, alpha: 0, spec: 1, cast: 0 });

  /* ============ EXTERIOR: bairro, céu e transformador ============ */
  W.city = buildExterior(add);
  W.lights = {
    lamps: [[-1.3, 1.95, -0.2], [1.9, 1.95, 0.9]], floor: [-3.62, 1.5, 2.45], fridge: [-3.3, 1.2, -1.9], micro: [-2.3, 1.2, -2.35], emerg: [-0.95, 2.3, 2.7],
    microFire: [-2.35, 1.0, -2.68], sprinklers: [[-2.4, 2.85, -1.6], [2.4, 2.85, -1.6], [-2.4, 2.85, 1.6], [2.4, 2.85, 1.6]],
  };
  return W;
}

/* Bairro visto pelas janelas. Janela esquerda (oeste): rua com postes, casas e prédios. Janela direita (leste): quintal,
   transformador, rua e casas. Cada fachada FICA VOLTADA para a sala (sx = +1 / -1), as janelas acendem por limiar
   (a cidade volta aos poucos) e tudo é apoiado no chão. Uma malha só, com fog para dar profundidade. */
function buildExterior(add) {
  const b = new MeshBuilder(77), gen = new MeshBuilder(8), r = mulberry32(99), tops = [];
  const warm = [C(0xffd48a), C(0xffc36b), C(0xfff0c8), C(0xffe0a0)], cool = [C(0xa9d8ff), C(0xcfe6ff)];
  const lawn = C(0x1f3f33), road = C(0x242a35), walk = C(0x555c69), line = C(0xd9d27a);
  const pick = a => a[(r() * a.length) | 0];
  b.box(0, -0.4, 0, 700, 0.7, 700, lawn, { ao: 1, j: 0 });                                  // chão (topo em y = -0.05)
  // só a face de cima e com comprimento moderado: caixas de 420 m x 3 cm geravam triângulos-fatia com profundidade imprecisa (linhas pontilhadas sobre a parede)
  const strip = (x, w, col) => b.box(x, -0.035, 0, w, 0.03, 200, col, { ao: 1, j: 0, skip: 'bflrk' });
  strip(-8.2, 1.6, walk); strip(-12, 6, road); strip(-15.8, 1.6, walk); strip(9.2, 1.6, walk); strip(13, 6, road); strip(16.8, 1.6, walk);
  for (let z = -60; z < 60; z += 3.4) { b.box(-12, -0.02, z, 0.14, 0.01, 1.3, line, { ao: 1, j: 0 }); b.box(13, -0.02, z, 0.14, 0.01, 1.3, line, { ao: 1, j: 0 }); }

  // cerca branca, cerca viva e canteiro do quintal esquerdo
  for (let z = -24; z <= 24; z += 0.5) b.box(-6.8, 0.33, z, 0.07, 0.66, 0.09, C(0xe8e0cc), { ao: 0.6, j: 0.04 });
  b.box(-6.8, 0.5, 0, 0.05, 0.06, 48, C(0xe8e0cc), { ao: 1 }); b.box(-6.8, 0.2, 0, 0.05, 0.06, 48, C(0xe8e0cc), { ao: 1 });
  for (let z = -22; z < 22; z += 2 + r() * 1.4) b.sphere(-5.6 + r() * 0.4, 0.32, z, 0.4 + r() * 0.15, C(0x2c7a4a), { jit: 0.18, ry: 0.85 });
  // quintal direito
  for (let z = -24; z <= 24; z += 0.5) b.box(8.0, 0.33, z, 0.07, 0.66, 0.09, C(0xe8e0cc), { ao: 0.6, j: 0.04 });
  b.box(8.0, 0.5, 0, 0.05, 0.06, 48, C(0xe8e0cc), { ao: 1 }); b.box(8.0, 0.2, 0, 0.05, 0.06, 48, C(0xe8e0cc), { ao: 1 });
  for (let z = -20; z < 20; z += 2.2 + r() * 1.4) b.sphere(5.5 + r() * 0.4, 0.3, z, 0.36 + r() * 0.15, C(0x2c7a4a), { jit: 0.18, ry: 0.85 });

  const tree = (x, z, s) => { b.cyl(x, 0.9 * s, z, 0.09 * s, 0.14 * s, 1.8 * s, 6, C(0x5a3d2b)); b.sphere(x, 2.2 * s, z, 0.95 * s, C(0x2f7d4f), { jit: 0.2, ry: 1.05 }); b.sphere(x + 0.45 * s, 2.85 * s, z + 0.2 * s, 0.62 * s, C(0x3a9358), { jit: 0.24 }); };
  tree(-7.6, -5, 1.3); tree(-7.5, 6.5, 1.1); tree(-7.9, -13, 1.4); tree(-7.7, 15, 1.2); tree(-16.8, -2, 1.3); tree(-16.6, 9, 1.2);
  tree(9.1, 2.0, 1.2); tree(9.0, -7.5, 1.0); tree(9.2, 9, 1.3); tree(17.4, -3, 1.2); tree(17.6, 8, 1.1);

  // carro de verdade: carroceria baixa, cabine com vidros, 4 rodas com o eixo na horizontal, faróis e lanternas
  const car = (x, z, ry, c) => b.group({ pos: [x, 0, z], ry }, () => {
    b.box(0, 0.5, 0, 1.8, 0.46, 4.2, c, { ao: 0.7 }); b.box(0, 0.78, 0.9, 1.7, 0.1, 1.2, dimC(c, 0.9), { ao: 1 });
    b.box(0, 0.98, -0.2, 1.56, 0.42, 2.1, dimC(c, 0.9), { ao: 1, j: 0 }); b.box(0, 1.0, -0.2, 1.6, 0.3, 1.9, C(0x15202a), { ao: 1, j: 0 }); b.box(0, 1.2, -0.2, 1.5, 0.06, 1.8, dimC(c, 0.8), { ao: 1 });
    [[-0.9, -1.3], [0.9, -1.3], [-0.9, 1.35], [0.9, 1.35]].forEach(([wx, wz]) => b.group({ pos: [wx, 0.32, wz], rz: Math.PI / 2 }, () => { b.cyl(0, 0, 0, 0.32, 0.32, 0.24, 8, C(0x14171c)); b.cyl(0, 0, 0, 0.17, 0.17, 0.26, 8, C(0xaab4bc)); }));
    [-0.6, 0.6].forEach(lx => { b.box(lx, 0.56, 2.11, 0.34, 0.14, 0.04, [1, 0.92, 0.65], { ao: 1, em: 1.2, j: 0 }); b.box(lx, 0.56, -2.11, 0.34, 0.1, 0.04, [0.9, 0.1, 0.08], { ao: 1, em: 0.9, j: 0 }); });
    b.box(0, 0.3, 2.12, 1.7, 0.14, 0.08, C(0x20252c), { ao: 1, j: 0 }); b.box(0, 0.3, -2.12, 1.7, 0.14, 0.08, C(0x20252c), { ao: 1, j: 0 });
  });
  car(-10.4, -4.5, 0, C(0xd45a4a)); car(-10.4, 5.5, 0, C(0x4a86c8)); car(-10.4, 14, 0, C(0xe0b34a)); car(11.4, -5, 0, C(0xe0b34a)); car(11.4, 6, 0, C(0x6bb36b));

  // postes de rua: lâmpada acende junto com a cidade
  const lampPost = (x, z, sx) => b.group({ pos: [x, 0, z] }, () => { b.cyl(0, 2.3, 0, 0.045, 0.07, 4.6, 6, C(0x38414c)); b.box(sx * 0.45, 4.55, 0, 0.9, 0.07, 0.1, C(0x38414c)); b.box(sx * 0.85, 4.47, 0, 0.34, 0.07, 0.2, [1, 0.88, 0.6], { ao: 1, em: 3.4, th: 0.12 + r() * 0.55, j: 0 }); });
  for (let z = -40; z <= 40; z += 8) { lampPost(-8.9, z + 2, 1); lampPost(9.3, z - 2, -1); }
  /* ---- casas: paredes, telhado de duas águas, porta, janelas e lâmpada de varanda. sx = lado para onde a frente aponta ---- */
  const house = (x, z, w, d, h, sx) => {
    const wall = C(pick([0xc9b79c, 0xb7c4cc, 0xd4a89a, 0xa9c2a2, 0xcdbf8a])), roof = C(pick([0x7a3b32, 0x4b5566, 0x6a4a36])), fx = x + sx * (d / 2 + 0.02);
    b.box(x, h / 2, z, d, h, w, wall, { ao: 0.6, j: 0.03 }); b.wedge(x, h + 0.8, z, d + 0.8, 1.6, w + 0.8, roof);
    b.box(x - sx * 0.6, h + 1.5, z + w * 0.25, 0.5, 1.0, 0.5, dimC(wall, 0.7), { ao: 1 });
    b.quad([fx, 0, z - 0.5], [fx, 0, z + 0.5], [fx, 2.1, z + 0.5], [fx, 2.1, z - 0.5], [sx, 0, 0], C(0x4a3326), 1);
    [-1, 1].forEach(k => { const zc = z + k * w * 0.3, lit = r() < 0.8, th = lit ? 0.02 + r() * 0.96 : 2, c = pick(warm), tgt = (r() < 0.07) ? gen : b, tth = tgt === gen ? 0 : th;
      b.quad([fx, 1.0, zc - 0.55], [fx, 1.0, zc + 0.55], [fx, 2.2, zc + 0.55], [fx, 2.2, zc - 0.55], [sx, 0, 0], C(0x262d3a), 1);
      tgt.quad([fx + sx * 0.01, 1.08, zc - 0.47], [fx + sx * 0.01, 1.08, zc + 0.47], [fx + sx * 0.01, 2.12, zc + 0.47], [fx + sx * 0.01, 2.12, zc - 0.47], [sx, 0, 0], c, 1, 1.9, tth); });
    b.box(fx + sx * 0.06, 2.45, z + 0.75, 0.12, 0.16, 0.12, [1, 0.9, 0.6], { ao: 1, em: 3, th: 0.1 + r() * 0.5, j: 0 });
  };
  for (let z = -66; z < 66; z += 10.5 + r() * 3) house(-21 - r() * 1.5, z, 6.5 + r() * 2.5, 7, 3.4, 1);
  for (let z = -66; z < 66; z += 10.5 + r() * 3) house(22 + r() * 1.5, z, 6.5 + r() * 2.5, 7, 3.4, -1);

  /* ---- prédios: base escura, parapeito, caixa d'água, faixas de laje e janelas só nas faces visíveis ---- */
  const tower = (x, z, w, d, h, sx) => {
    const base = C(pick([0x39425c, 0x433b57, 0x2f4a55, 0x4a4160, 0x2e3b58])), fx = x + sx * (d / 2 + 0.02);
    b.box(x, h / 2, z, d, h, w, base, { ao: 0.55, j: 0.04 }); b.box(x, h + 0.35, z, d + 0.3, 0.7, w + 0.3, dimC(base, 0.8), { ao: 1 });
    if (r() < 0.6) b.cyl(x - sx * d * 0.15, h + 1.5, z + w * 0.2, 1.0, 1.0, 1.6, 7, C(0x4b5563), { ao: 1 });
    if (r() < 0.4) b.cyl(x, h + 3, z - w * 0.2, 0.05, 0.05, 4.5, 4, C(0x2b3440));
    if (h > 34) tops.push([x, h, z]);
    const cols = Math.max(2, Math.floor(w / 2.4)), rows = Math.max(2, Math.floor((h - 1.5) / 3));
    for (let j = 0; j < rows; j++) {
      const y = 1.6 + j * 3; if (j % 3 === 2) b.box(x + sx * (d / 2), y + 1.9, z, 0.1, 0.2, w + 0.1, dimC(base, 0.7), { ao: 1, j: 0 });
      for (let i = 0; i < cols; i++) {
        const zc = z + ((i + 0.5) / cols - 0.5) * w * 0.9, lit = r() < 0.7, th = lit ? 0.02 + r() * 0.96 : 2, c = r() < 0.15 ? pick(cool) : pick(warm), tgt = (r() < 0.05) ? gen : b, tth = tgt === gen ? 0 : th;
        tgt.quad([fx, y, zc - 0.5], [fx, y, zc + 0.5], [fx, y + 1.3, zc + 0.5], [fx, y + 1.3, zc - 0.5], [sx, 0, 0], c, 1, 1.9, tth);
      }
    }
  };
  [[-32, 0, 13, 11], [-52, 1, 12, 19], [-76, 2, 12, 28]].forEach(([x0, row, w0, hMax]) => {
    for (let z = -110 + r() * 6; z < 110;) { const w = w0 + r() * 8, d = 9 + r() * 5, h = 10 + r() * hMax + row * 10; tower(x0 - r() * 3, z + w / 2, w, d, h, 1); z += w + 3 + r() * 7; }
  });
  [[42, 0, 12, 14], [64, 1, 12, 24]].forEach(([x0, row, w0, hMax]) => {
    for (let z = -100 + r() * 6; z < 100;) { const w = w0 + r() * 8, d = 9 + r() * 5, h = 10 + r() * hMax + row * 10; tower(x0 + r() * 3, z + w / 2, w, d, h, -1); z += w + 3 + r() * 7; }
  });
  // montanhas facetadas ao fundo, nos dois lados
  for (let i = 0; i < 12; i++) { const z = -230 + i * 40 + r() * 12, h = 40 + r() * 60; b.group({ pos: [-215 - r() * 40, 0, z] }, () => b.cone(0, h / 2, 0, 38 + r() * 28, h, 5 + ((r() * 3) | 0), C(0x1c2a44), { ao: 1, j: 0.1 })); }
  for (let i = 0; i < 12; i++) { const z = -230 + i * 40 + r() * 12, h = 35 + r() * 50; b.group({ pos: [215 + r() * 40, 0, z] }, () => b.cone(0, h / 2, 0, 38 + r() * 28, h, 5 + ((r() * 3) | 0), C(0x1c2a44), { ao: 1, j: 0.1 })); }

  // exterior: ambiente e luz de teto reduzidos (não é "dia lá fora quando acendo a lâmpada")
  const ext = { cast: 0, fixed: true, ambK: 0.5, d1K: 0, spec: 0.03 };
  const city = add(new Obj(b.build(), Object.assign({ power: 0, tint: [0.85, 0.85, 0.92] }, ext)));
  const bl = new MeshBuilder(5); tops.slice(0, 4).forEach(([x, h, z]) => bl.sphere(x, h + 5.4, z, 0.6, [1, 0.15, 0.1], { det: 0, em: 5, ao: 1, j: 0 }));
  city.blink = add(new Obj(bl.build(), Object.assign({ power: 1 }, ext)));
  city.gen = add(new Obj(gen.build(), Object.assign({ power: 1 }, ext)));      // janelas com gerador: acesas mesmo no apagão, mas coladas nas fachadas
  return city;
}

/* ============================ 9. LÓGICA DO JOGO ============================ */
const NOMES = { luz: 'as Luzes', vent: 'o Ventilador', gela: 'a Geladeira', micro: 'o Micro-ondas' };
const TEMPLATES = [(x, y) => `Primeiro ${x}, logo depois ${y}.`, (x, y) => `Na ordem: ${x} e, em seguida, ${y}.`, (x, y) => `Anotado: ${x} antes; ${y} depois.`];
const AUTORES = { a: 'Pedrinho (desenho)', b: 'Seu Zé, eletricista', c: 'Vovó Neide' };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; };
const TOOL_LIST = [['screw', 'Chave de fenda'], ['multi', 'Multímetro'], ['pliers', 'Alicate'], ['flash', 'Lanterna'], ['extintor', 'Extintor']];
const TOOL_ICON = { screw: '🪛', multi: '📟', pliers: '🔧', flash: '🔦', extintor: '🧯' };

const S = {};            // estado da partida
let W, R, G;             // mundo, renderer, utilidades do jogo
const Opt = { bob: true, sparkles: true, auto: true, quality: 'alta', ...(() => { try { return JSON.parse(localStorage.getItem('voltaluz.opt') || '{}'); } catch (e) { return {}; } })() };
const Best = (() => { try { return JSON.parse(localStorage.getItem('voltaluz.best') || 'null'); } catch (e) { return null; } })();

function newRun() {
  const order = shuffle(BRANCHES);
  const pairs = shuffle([0, 1, 2]).map((i, k) => ({ a: order[i], b: order[i + 1], id: ['a', 'b', 'c'][k] }));
  const clues = {}; pairs.forEach((p, i) => { const t = TEMPLATES[(Math.random() * 3) | 0]; clues[p.id] = { id: p.id, a: p.a, b: p.b, author: AUTORES[p.id], short: t(NOMES[p.a], NOMES[p.b]) }; });
  Object.assign(S, {
    running: false, paused: false, done: false, t: 0, errors: 0, hints: 0, shocks: 0, order, seq: ['geral', ...order], clues, read: {}, guess: [],
    fuse: 0, bay: false, measured: false, fuseSeen: false, gloves: false, warned: false, cabinetOpen: false, spare: false,
    tools: {}, sel: null, flashOn: false, on: {}, prog: 0, fire: false, fireT: 0, fireHP: 0, spr: 0, wet: 0, shk: 0, blown: 0, crazy: 0, fridgeOpen: 0,
    lever: {}, lp: 0, roomOn: false, meter: 0, hintLv: 0, endT: 0, cityPower: 0, flashSpark: 0, time0: 0,
  });
  // visual do mundo de volta ao início
  Object.values(W.items).forEach(o => o.visible = true); W.items.glove.visible = false;
  Object.keys(CIRC).forEach(k => S.lever[k] = -0.45);
  W.panel.cover.visible = true; W.panel.fuses[1].mesh = W.panel.meshes.burnt; W.panel.fuses[1].visible = true; W.panel.fuses[1].rot = [0, 0, 0];
  Object.values(W.notes).forEach(n => paintClue(n.ct, clues[Object.keys(W.notes).find(k => W.notes[k] === n)], n.style));
  W.cabinet.doorL.rot[1] = 0; W.cabinet.doorR.rot[1] = 0; W.fridge.door.rot[1] = 0;
  G.parts.forEach(p => p.clear());
}

/* ---------- Interações: cada item diz o que mostra e o que faz, conforme a ferramenta na mão ---------- */
const INTS = [];
function defInt(o) { INTS.push(Object.assign({ reach: 3.0 }, o)); return o; }

function say(text, ms = 5200) {
  const b = $('#bubble'); $('#bubbleText').textContent = text; b.classList.add('on'); clearTimeout(say.t); say.t = setTimeout(() => b.classList.remove('on'), ms);
  SFX.fx.meow(); G.catHappy = 2.2;
}
function toast(text, kind = '') {
  const t = $('#toast'); t.textContent = text; t.className = 'on ' + kind; clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3800);
}
function showCard(imgSrc, title, text) {
  S.card = true; $('#cardImg').src = imgSrc || ''; $('#cardImg').style.display = imgSrc ? '' : 'none'; $('#cardTitle').textContent = title; $('#cardText').textContent = text; $('#card').classList.add('on');
}
function closeCard() { S.card = false; $('#card').classList.remove('on'); }

function shock(reason) {
  if (S.shk > 0) return;
  S.shk = 0.8; S.shocks++; S.errors++; S.t += 10; SFX.fx.zap();
  G.sparks([G.cam.pos[0] + G.cam.fwd[0] * 0.8, 1.35, G.cam.pos[2] + G.cam.fwd[2] * 0.8], 26);
  toast(reason || 'ZZZAP! Sem luvas, a eletricidade encontra você. +10 s', 'bad'); say('Miau! Luvas isolantes antes de mexer no quadro!', 4000);
}
/* Antes de mexer no quadro: luvas. Primeira vez só avisa; depois dá choque. */
function panelGuard(force) {
  const hazard = force || S.fuse >= 3 || S.spr > 0 || S.wet > 0 || S.sel;
  if (S.gloves || !hazard) return false;
  if (!S.warned) { S.warned = true; toast('Cuidado! Calce as luvas isolantes antes de mexer no quadro.', 'warn'); say('Miau! Pegue as luvas no armário roxo. Dessa vez eu aviso; na próxima dá choque!'); return true; }
  if (S.spr > 0 || S.wet > 0) shock('ZZZAP! O quadro está molhado e você está sem luvas. +10 s'); else shock();
  return true;
}
function pick(key, name, extra) {
  S.items = S.items || {}; W.items[key].visible = false; SFX.fx.pick();
  if (TOOL_ICON[key]) { S.tools[key] = true; if (!S.sel) selectTool(key); }
  toast(name + ' no bolso!', 'good'); extra && extra();
}
function selectTool(k) {
  if (k && !S.tools[k]) { toast('Você ainda não pegou essa ferramenta.', 'warn'); return; }
  S.sel = k; SFX.fx.click(); drawTools();
}
function toggleFlash() { if (!S.tools.flash) return; S.flashOn = !S.flashOn; SFX.fx.click(); drawTools(); }

function setupInteractions() {
  const items = W.items, P = W.panel;
  const hand = () => !S.sel;
  // --- pegar coisas ---
  defInt({ id: 'glove', obj: items.glove, enabled: () => S.cabinetOpen && !S.gloves, info: () => ({ label: 'Pegar luvas isolantes', fn: () => { S.gloves = true; items.glove.visible = false; SFX.fx.pick(); toast('Luvas calçadas! Agora o quadro está mais seguro (no jogo).', 'good'); drawTools(); } }) });
  defInt({ id: 'cabinet', aabb: { min: [3.3, 0, 1.4], max: [3.98, 2.0, 2.4] }, enabled: () => !S.cabinetOpen, info: () => ({ label: 'Abrir o armário roxo', fn: () => { S.cabinetOpen = true; items.glove.visible = !S.gloves; SFX.fx.door(); } }) });
  [['screw', 'Chave de fenda'], ['pliers', 'Alicate'], ['multi', 'Multímetro'], ['flash', 'Lanterna']].forEach(([k, n]) => defInt({ id: k, obj: items[k], enabled: () => !S.tools[k], info: () => ({ label: 'Pegar ' + n.toLowerCase(), fn: () => pick(k, n) }) }));
  defInt({ id: 'spare', obj: items.spare, enabled: () => !S.spare, info: () => ({ label: 'Pegar fusível reserva', fn: () => { S.spare = true; items.spare.visible = false; SFX.fx.pick(); toast('Fusível reserva guardado!', 'good'); } }) });
  defInt({ id: 'ext', obj: items.extintor, reach: 3.4, enabled: () => !S.tools.extintor, info: () => ({ label: 'Pegar o extintor', fn: () => pick('extintor', 'Extintor de CO₂', () => { toast('Selecione o extintor (5) e segure o clique perto do fogo.', 'good'); }) }) });
  // --- pistas ---
  ['a', 'b', 'c'].forEach(id => defInt({ id: 'note' + id, obj: W.notes[id].obj, reach: 3.2, info: () => ({ label: 'Ler ' + (id === 'a' ? 'o desenho' : id === 'b' ? 'o quadro branco' : 'o bilhete'), fn: () => { S.read[id] = true; SFX.fx.ding(); const c = S.clues[id]; showCard(W.notes[id].ct.c.toDataURL(), c.author, c.short + '  (Anote no caderno: Tab)'); drawJournal(); } }) }));
  defInt({ id: 'sticker', obj: W.sticker, info: () => ({ label: 'Ler o aviso do eletricista', fn: () => { S.read.s = true; SFX.fx.ding(); showCard('', 'Aviso do eletricista', 'No quadro da casa, a chave GERAL liga sempre primeiro. Sem ela, nenhum aparelho recebe energia. Depois dela, cada aparelho tem a sua vez!'); drawJournal(); } }) });
  // --- tampa e fusíveis ---
  defInt({ id: 'cover', obj: P.cover, reach: 3.0, enabled: () => !S.bay, info: t => t === 'screw' ? { label: 'Segure: desparafusar a tampa', hold: 1.6, fn: () => { if (panelGuard()) return; S.bay = true; P.cover.visible = false; P.fuseLabels.forEach(l => l.visible = true); SFX.fx.thunk(); toast('Tampa aberta. Lá dentro está escuro... use a lanterna (4)!', 'good'); }, sfx: 'screw' } : { label: 'Tampa dos fusíveis: precisa da chave de fenda (1)', fn: () => toast('Parafusada. Use a chave de fenda (tecla 1) segurando o clique.', 'warn') } });
  defInt({ id: 'fuse', aabb: { min: [-0.2, 2.0, -2.88], max: [0.2, 2.3, -2.72] }, enabled: () => S.bay, info: t => {
    const dark = !S.flashOn;
    if (S.fuse === 0) {
      if (t === 'multi') return { label: 'Medir o fusível F2', fn: () => { if (panelGuard()) return; S.measured = true; meter('F2', '0,0 V', 'Aberto: o fusível queimou.'); } };
      if (t === 'pliers') return S.measured ? { label: 'Segure: retirar o fusível queimado', hold: 1.0, sfx: 'snip', fn: () => { if (panelGuard()) return; S.fuse = 1; P.fuses[1].visible = false; G.sparks([0, 2.15, -2.74], 10); SFX.fx.spark(); toast('Fusível queimado fora! Agora o reserva da bancada.', 'good'); } } : { label: 'Meça antes de mexer (multímetro, 2)', fn: () => toast('Regra de ouro: meça antes de mexer! Use o multímetro (2) no F2.', 'warn') };
      return { label: dark ? 'Muito escuro... ligue a lanterna (4)' : 'F2 está queimado. Meça (2) e retire (3)', fn: () => toast(dark ? 'Escuro demais. Selecione a lanterna (4).' : 'O F2 está carbonizado: meça com o multímetro (2) e retire com o alicate (3).', 'warn') };
    }
    if (S.fuse === 1) return S.spare ? { label: 'Segure: encaixar o fusível novo', hold: 0.7, fn: () => { if (panelGuard()) return; S.sel = null; drawTools(); S.fuse = 2; P.fuses[1].mesh = P.meshes.fresh; P.fuses[1].visible = true; P.fuses[1].rot[2] = 0.14; SFX.fx.pick(); toast('Fusível novo encaixado, mas está frouxo. Aperte com a chave (1).', 'good'); } } : { label: 'Soquete vazio: pegue o fusível reserva na bancada', fn: () => toast('O fusível reserva está na bancada, à direita.', 'warn') };
    if (S.fuse === 2) {
      if (t === 'screw') return { label: 'Segure: apertar o parafuso', hold: 1.4, sfx: 'screw', fn: () => { if (panelGuard()) return; S.fuse = 3; P.fuses[1].rot[2] = 0; SFX.fx.good(); toast('Apertado! O quadro agora tem 12 V. Hora de ligar os disjuntores.', 'good'); } };
      if (t === 'multi') return { label: 'Medir o F2', fn: () => meter('F2', '3,1 V ~', 'Leitura oscilando: parafuso frouxo.') };
      return { label: 'Fusível frouxo: aperte com a chave de fenda (1)', fn: () => toast('Aperte o parafuso com a chave de fenda (1).', 'warn') };
    }
    return t === 'multi' ? { label: 'Medir o F2', fn: () => meter('F2', '12,0 V', 'Tensão firme. Tudo certo!') } : { label: 'F2 em ordem', fn: () => toast('F2 em ordem: 12 V firmes.', 'good') };
  } });
  // --- disjuntores ---
  Object.keys(CIRC).forEach(k => defInt({ id: 'br' + k, obj: P.levers[k], aabb: null, reach: 3.2, info: t => {
    const c = CIRC[k];
    if (t === 'multi') return { label: 'Medir ' + c.nome, fn: () => { const v = !S.on[k] ? '0,0 V' : '12,0 V'; meter(c.nome, v, S.fuse < 3 ? 'Sem tensão na entrada do quadro.' : (S.on[k] ? 'Ligado e estável.' : (k === 'geral' ? 'A entrada tem 12 V; o geral está desligado.' : 'Desligado: sem tensão na saída.'))); } };
    return { label: (S.on[k] ? 'Desligar ' : 'Ligar ') + c.nome, fn: () => { if (t && t !== 'extintor') { S.sel = null; drawTools(); } pressBreaker(k); } };   // guarda a ferramenta sozinho
  } }));
  // --- gato e rádio ---
  defInt({ id: 'cat', aabb: W.catAABB, reach: 3.4, info: () => ({ label: 'Fazer carinho no Fusível (pedir dica)', fn: () => { SFX.fx.purr(); giveHint(); } }) });
  defInt({ id: 'radio', obj: W.radio.body, reach: 3.4, info: () => ({ label: SFX.Radio.on ? 'Desligar o rádio' : 'Ligar o rádio', fn: () => { const on = SFX.Radio.toggle(); W.radio.screen.power = on ? 1 : 0.12; SFX.fx.click(); toast(on ? '♪ ' + SFX.Radio.name : 'Rádio desligado.'); } }) });
}

function meter(what, value, note) { S.meter = 4; $('#meterWhat').textContent = what; $('#meterVal').textContent = value; $('#meterNote').textContent = note; SFX.fx.beep(980); }

/* ---------- Disjuntores: a lógica central do puzzle ---------- */
function pressBreaker(k) {
  if ((S.spr > 0 || S.wet > 0) && panelGuard(true)) return;
  if (!S.gloves && S.fuse >= 3 && panelGuard()) return;
  const c = CIRC[k];
  if (S.on[k]) {                                          // desligar: derruba também o que vem depois
    const idx = S.seq.indexOf(k); S.seq.slice(idx).forEach(x => S.on[x] = false); S.prog = Math.min(S.prog, idx);
    SFX.fx.thunk(); if (k === 'micro') S.fire = false; return;
  }
  if (S.fuse < 3) { SFX.fx.click(); S.lever[k] = 0; toast('Sem energia na entrada (0 V). Conserte o fusível F2 primeiro.', 'warn'); return; }
  if (k !== 'geral' && !S.on.geral) { SFX.fx.bad(); toast('A chave GERAL liga primeiro. Sem ela, nada recebe energia.', 'warn'); return; }
  if (S.seq[S.prog] === k) {                              // certo!
    S.on[k] = true; S.prog++; SFX.fx.breakerOn(S.prog);
    const msgs = ['', 'Energia na casa! Agora, qual é o próximo?', 'Boa! Está funcionando.', 'Ótimo, mais um!', 'Quase lá!', ''];
    if (S.prog < 5) toast((k === 'geral' ? '' : c.nome + ' ligou. ') + msgs[S.prog], 'good');
    G.sparks([BREAKER_X[k], 1.4, -2.7], 6);
    if (S.prog === 5) checkWin();
    return;
  }
  // errado: o disjuntor desarma e o aparelho "reclama"
  S.errors++; S.t += 10; SFX.fx.trip(); S.flashSpark = 1; G.sparks([BREAKER_X[k], 1.3, -2.72], 22);
  S.lever[k] = 0.6; S.on[k] = false;
  if (k === 'luz') { S.blown = 5; SFX.fx.pop(); toast('POP! As lâmpadas estouraram de susto e a sala escureceu por uns segundos. +10 s', 'bad'); }
  else if (k === 'vent') { S.crazy = 3.5; toast('O ventilador pirou e espalhou os papéis! +10 s', 'bad'); G.papers(); }
  else if (k === 'gela') { S.fridgeOpen = 4.5; toast('A geladeira abriu sozinha e jogou gelo! +10 s', 'bad'); G.ice(); }
  else { S.fire = true; S.fireT = 0; S.fireHP = 1.4; S.fireDoor = 1; toast('CURTO! Fogo no micro-ondas! Pegue o extintor na parede dos fundos! +10 s', 'bad'); say('Miau!! Fogo! O extintor está na parede, ao lado da bancada!', 6000); }
  if (k !== 'micro') say('Miau... ordem errada. Procure as pistas: geladeira, quadro branco e parede da bancada.', 5200);
}

function checkWin() {
  if (S.done || S.prog < 5 || S.fire || S.spr > 0) return;
  S.done = true; S.endT = 3.6; SFX.fx.win(); SFX.Music.setMood('party'); G.confetti(); closeCard();
  toast('ENERGIA RESTAURADA!', 'good');
}
function endScreen() {
  S.running = false; if (document.pointerLockElement) document.exitPointerLock();
  const t = S.t; let stars = 3; if (t > 480) stars--; if (S.errors > 3) stars--; if (S.hints > 2) stars--; stars = Math.max(1, stars);
  $('#endStars').innerHTML = [1, 2, 3].map(i => `<span class="star ${i <= stars ? 'on' : ''}"></span>`).join('');
  $('#endStats').innerHTML = `<li><b>${fmtTime(t)}</b> tempo total</li><li><b>${S.errors}</b> trapalhadas</li><li><b>${S.hints}</b> dicas do gato</li>`;
  const prev = Best && Best.t; let best = Best;
  if (!best || stars > best.stars || (stars === best.stars && t < best.t)) { best = { t, stars }; try { localStorage.setItem('voltaluz.best', JSON.stringify(best)); } catch (e) { } }
  $('#endBest').textContent = best ? `Melhor marca: ${fmtTime(best.t)} · ${best.stars} ${best.stars > 1 ? 'estrelas' : 'estrela'}` : '';
  $('#endOrder').innerHTML = S.seq.map(k => `<img src="${iconURL(CIRC[k].icon, hexCss(CIRC[k].col))}" alt="${CIRC[k].nome}" title="${CIRC[k].nome}">`).join('<i>›</i>');
  show('end');
}

function giveHint() {
  S.hints++; const unread = ['a', 'b', 'c'].filter(i => !S.read[i]);
  const where = { a: 'a porta da geladeira', b: 'o quadro branco da parede dos fundos', c: 'a parede perto da bancada' };
  if (!S.gloves) return say('Miau! As luvas isolantes estão no armário roxo, do lado direito da sala.');
  if (S.fuse < 3) return say(!S.bay ? 'Miau! Pegue a chave de fenda e a lanterna na bancada. A tampa dos fusíveis fica no alto do quadro.' : 'Miau! Meça o F2, retire o queimado, encaixe o reserva com as mãos e aperte com a chave.');
  if (S.fire) return say('Miau! Extintor na parede, ao lado da bancada. Selecione (5) e segure o clique perto do fogo!');
  if (unread.length) return say('Miau! Falta ler ' + where[unread[0]] + '. As pistas dizem quem liga logo antes de quem.');
  S.hintLv++;
  if (S.hintLv < 2) return say('Miau! Cruze as três pistas: quem nunca aparece como "depois" é o primeiro. Depois do GERAL, claro!');
  say('Miau! O próximo disjuntor é: ' + (CIRC[S.seq[Math.min(S.prog, 4)]].nome) + '.');
}

/* ---------- Objetivo atual (guia o jogador sem tirar a diversão) ---------- */
function objective() {
  if (S.done) return { t: 'Luz de volta!', w: 'A casa respira de novo.', g: [] };
  if (S.spr > 0) return { t: 'Sprinklers ligados!', w: 'Água e eletricidade não combinam. Espere secar um pouco.', g: [] };
  if (S.fire) return { t: 'Apague o fogo!', w: 'O extintor de CO₂ é o certo para fogo em aparelho elétrico. Segure o clique apontando para as chamas.', g: S.tools.extintor ? [W.lights.microFire] : [[3.38, 1.1, -2.9]] };
  const L = W.lights;
  if (!S.gloves) return { t: S.cabinetOpen ? 'Pegue as luvas' : 'Abra o armário roxo', w: 'Luvas isolantes são o primeiro item de segurança. (No jogo, claro!)', g: [S.cabinetOpen ? [3.7, 1.25, 1.9] : [3.5, 1.1, 1.9]] };
  if (!S.tools.screw || !S.tools.flash) return { t: 'Pegue a chave de fenda e a lanterna', w: 'Estão na bancada, na parede da direita.', g: [!S.tools.screw ? [3.56, 1.12, -1.85] : [3.56, 1.12, 0.0]] };
  if (!S.bay) return { t: 'Abra a tampa dos fusíveis', w: 'Selecione a chave de fenda (1) e segure o clique na tampa, no alto do quadro.', g: [[0, 2.15, -2.75]] };
  if (S.fuse === 0) {
    if (!S.tools.multi) return { t: 'Pegue o multímetro', w: 'Ele mede a tensão: é como um termômetro da eletricidade.', g: [[3.56, 1.12, -0.85]] };
    if (!S.measured) return { t: 'Meça o fusível F2', w: 'Ligue a lanterna (4), selecione o multímetro (2) e clique no F2. Medir antes de mexer é regra de ouro.', g: [[0, 2.15, -2.75]] };
    if (!S.tools.pliers) return { t: 'Pegue o alicate', w: 'O alicate segura peças pequenas e quentes. Está na bancada.', g: [[3.56, 1.12, -1.35]] };
    return { t: 'Retire o fusível queimado', w: 'Selecione o alicate (3) e segure o clique no F2.', g: [[0, 2.15, -2.75]] };
  }
  if (S.fuse === 1) return S.spare ? { t: 'Encaixe o fusível novo', w: 'Guarde a ferramenta (0) e segure o clique com as mãos.', g: [[0, 2.15, -2.75]] } : { t: 'Pegue o fusível reserva', w: 'O fusível é o "segurança" do circuito: queima para proteger. Tem um reserva na bancada.', g: [[3.56, 1.12, -0.42]] };
  if (S.fuse === 2) return { t: 'Aperte o parafuso do fusível', w: 'Contato frouxo esquenta e falha. Chave de fenda (1), segurando o clique.', g: [[0, 2.15, -2.75]] };
  const unread = ['a', 'b', 'c'].filter(i => !S.read[i]);
  if (S.prog === 0) return { t: 'Ligue o disjuntor GERAL', w: 'Ele alimenta todos os outros. Aperte o vermelho, à esquerda no quadro.', g: [[BREAKER_X.geral, 1.3, -2.7]] };
  const g = unread.map(i => ({ a: [-3.55, 1.8, -2.1], b: [2.2, 1.72, -2.9], c: [3.9, 1.62, 0.86] }[i]));
  return { t: unread.length ? 'Descubra a ordem dos disjuntores (' + S.prog + '/5)' : 'Ligue na ordem certa (' + S.prog + '/5)', w: unread.length ? 'Leia as pistas: geladeira, quadro branco e parede da bancada. Cada uma diz quem liga logo antes de quem. Abra o caderno com Tab.' : 'Você tem todas as pistas! Cruze-as e ligue um por um. Errar custa tempo, não o jogo.', g };
}

/* ===================== 10. EFEITOS, ENTRADA, INTERFACE E LAÇO ===================== */
G = {
  parts: [new Particles(2500, true), new Particles(2500, false)], cam: { pos: [0, 1.62, 2.3], fwd: [0, 0, -1], fov: 68 * Math.PI / 180 },
  yaw: 0, pitch: 0, px: 0, pz: 2.3, vx: 0, vz: 0, bob: 0, stepT: 0, catHappy: 0, vm: {}, time: 0, hover: null, mood: '', lock: false,
};
const [PA, PB] = G.parts;   // aditivas / alfa
const rr = (a, b) => a + Math.random() * (b - a);
const rv = s => [rr(-s, s), rr(-s, s), rr(-s, s)];

G.sparks = (p, n) => { for (let i = 0; i < n; i++) PA.emit({ p: p.slice(), v: [rr(-3, 3), rr(0.5, 4), rr(-3, 3)], life: rr(0.3, 0.8), s0: 0.06, s1: 0.01, c0: [5, 3, 1, 1], c1: [1.5, 0.3, 0, 0], g: 9, drag: 0.6, shape: 1 }); };
G.confetti = () => { for (let i = 0; i < 380; i++) PA.emit({ p: [rr(-3.5, 3.5), rr(2.4, 3.0), rr(-2.5, 2.5)], v: [rr(-0.6, 0.6), rr(-1, 0), rr(-0.6, 0.6)], life: rr(3, 6), s0: rr(0.05, 0.1), c0: [[2.6, 0.5, 0.4, 1], [0.4, 2.2, 1.0, 1], [0.5, 1.2, 3, 1], [3, 2.4, 0.4, 1]][i % 4], c1: [1, 1, 1, 0], g: 1.3, drag: 0.5, shape: 1 }); };
G.papers = () => { for (let i = 0; i < 40; i++) PB.emit({ p: [0.3, 2.5, 0.2], v: [rr(-4, 4), rr(0, 2), rr(-4, 4)], life: rr(2, 3.2), s0: 0.13, c0: [0.95, 0.93, 0.85, 1], c1: [0.95, 0.93, 0.85, 0], g: 1.8, drag: 0.9, shape: 1, floor: true }); };
G.ice = () => { for (let i = 0; i < 30; i++) PB.emit({ p: [-3.2, 1.2, -1.9], v: [rr(0.5, 2.5), rr(0.5, 2.5), rr(0, 2.2)], life: rr(1.2, 2), s0: 0.09, c0: [0.7, 0.9, 1, 1], c1: [0.7, 0.9, 1, 0], g: 6, shape: 1, floor: true }); };
G.sparkle = p => PA.emit({ p: [p[0] + rr(-0.12, 0.12), p[1] + rr(0, 0.12), p[2] + rr(-0.12, 0.12)], v: [0, 0.3, 0], life: 1.2, s0: 0.1, s1: 0.0, c0: [3, 2.3, 0.6, 0.95], c1: [3, 1.6, 0.3, 0], shape: 0 });

/* ---------- entrada ---------- */
const keys = {}; let primary = false, holdInt = null, holdT = 0, holdSfx = 0, touch = { x: 0, y: 0 }, lookFail = false;
const touchMode = matchMedia('(pointer:coarse)').matches; if (touchMode) document.body.classList.add('touch');
function lockReq() { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => { lookFail = true; }); } catch (e) { lookFail = true; } }
function look(dx, dy) { G.yaw -= dx * 0.0022; G.pitch = clamp(G.pitch - dy * 0.0022, -1.35, 1.35); }
const live = () => S.running && !S.paused && !S.journal && !S.done;
addEventListener('keydown', e => {
  if (e.code === 'Tab') { e.preventDefault(); if (S.running && !S.paused && !S.done) toggleJournal(); return; }
  if (e.repeat) return; keys[e.code] = true;
  if (!S.running) return;
  if (e.code === 'Escape') { if (S.card) closeCard(); else if (S.journal) toggleJournal(); else if (S.paused) resumeGame(); else if (!S.done) pauseGame(); return; }
  if (S.paused || S.done) return;
  if (e.code === 'KeyM') { SFX.setMuted(!SFX.st.muted); toast(SFX.st.muted ? 'Som desligado' : 'Som ligado'); }
  if (S.journal) return;
  if (e.code === 'KeyE') actionDown(false);
  if (e.code === 'KeyH') giveHint();
  if (e.code === 'KeyF') toggleFlash();
  if (e.code === 'KeyQ' || e.code === 'Digit0') selectTool(null);
  const n = { Digit1: 'screw', Digit2: 'multi', Digit3: 'pliers', Digit4: 'flash', Digit5: 'extintor' }[e.code];
  if (n) { if (n === 'flash') { if (S.tools.flash) toggleFlash(); else toast('Pegue a lanterna na bancada.', 'warn'); } else selectTool(n); }
});
addEventListener('keyup', e => { keys[e.code] = false; if (e.code === 'KeyE') actionUp(); });
addEventListener('mousemove', e => { if (live() && (document.pointerLockElement === canvas || (lookFail && e.buttons & 2))) look(e.movementX, e.movementY); });
canvas.addEventListener('mousedown', e => { if (!live()) return; if (e.button === 0) { if (!document.pointerLockElement && !lookFail) lockReq(); actionDown(true); } });
addEventListener('mouseup', e => { if (e.button === 0) actionUp(); });
canvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('wheel', e => { if (!live()) return; const list = [null, ...TOOL_LIST.map(t => t[0]).filter(k => k !== 'flash' && S.tools[k])]; const i = list.indexOf(S.sel); selectTool(list[(i + (e.deltaY > 0 ? 1 : -1) + list.length) % list.length]); }, { passive: true });
document.addEventListener('pointerlockchange', () => { G.lock = document.pointerLockElement === canvas; if (!G.lock && S.running && !S.paused && !S.done && !S.card && !S.journal && !G.noPause) pauseGame(); });

function actionDown(fromMouse) {
  if (S.card) { closeCard(); return; }
  primary = true;
  if (fromMouse && S.sel === 'extintor' && S.tools.extintor) return;           // com o extintor, o clique só espirra
  const it = G.hover; if (!it) return; const info = it.info(S.sel); if (!info) return;
  if (info.hold) { holdInt = it; holdT = 0; holdSfx = 0; } else info.fn();
}
function actionUp() { primary = false; holdInt = null; holdT = 0; $('#ring').classList.remove('on'); }

/* ---------- raycast contra AABBs ---------- */
function objBox(o) {
  const m = o.world, a = o.mesh.min, b = o.mesh.max, mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b[0] : a[0], y = i & 2 ? b[1] : a[1], z = i & 4 ? b[2] : a[2];
    const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  }
  return { min: mn.map(v => v - 0.03), max: mx.map(v => v + 0.03) };
}
function rayBox(o, d, b) {
  let t0 = 0, t1 = 1e9;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-6) { if (o[k] < b.min[k] || o[k] > b.max[k]) return null; continue; }
    let a = (b.min[k] - o[k]) / d[k], c = (b.max[k] - o[k]) / d[k]; if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) return null;
  }
  return t0;
}
function pickAim() {
  let best = null, bt = 1e9; const c = G.cam;
  for (const it of INTS) {
    if (it.enabled && !it.enabled()) continue; if (it.obj && !it.obj.visible) continue;
    const t = rayBox(c.pos, c.fwd, it.aabb || objBox(it.obj));
    if (t !== null && t <= it.reach && t < bt) { bt = t; best = it; }
  }
  return best;
}

/* ---------- movimento com colisão (círculo x AABBs) ---------- */
function resolve(x, z) {
  const r = 0.27; x = clamp(x, -3.7, 3.7); z = clamp(z, -2.5, 2.65);
  for (const c of W.colliders) {
    const x0 = c.x0 - r, x1 = c.x1 + r, z0 = c.z0 - r, z1 = c.z1 + r;
    if (x > x0 && x < x1 && z > z0 && z < z1) {
      const dl = x - x0, dr = x1 - x, dt = z - z0, db = z1 - z, m = Math.min(dl, dr, dt, db);
      if (m === dl) x = x0; else if (m === dr) x = x1; else if (m === dt) z = z0; else z = z1;
    }
  }
  return [x, z];
}
function movePlayer(dt) {
  let f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - touch.y, r = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + touch.x;
  const l = Math.hypot(f, r); if (l > 1) { f /= l; r /= l; }
  const sp = (keys.ShiftLeft || keys.ShiftRight ? 3.9 : 2.5), s = G.yaw;
  const tx = (-Math.sin(s) * f + Math.cos(s) * r) * sp, tz = (-Math.cos(s) * f - Math.sin(s) * r) * sp;
  G.vx = damp(G.vx, tx, 12, dt); G.vz = damp(G.vz, tz, 12, dt);
  let [nx, nz] = resolve(G.px + G.vx * dt, G.pz); [nx, nz] = resolve(nx, nz + G.vz * dt);
  const moved = Math.hypot(nx - G.px, nz - G.pz); G.px = nx; G.pz = nz;
  G.bob += moved * 5.2; G.stepT += moved; if (G.stepT > 0.72) { G.stepT = 0; SFX.fx.step(); }
}

/* ---------- interface ---------- */
function show(id) { $$('.screen').forEach(e => e.classList.add('hide')); if (id) $('#' + id).classList.remove('hide'); G.screen = id; $('#hud').classList.toggle('hide', !!id && id !== 'pause'); }
function drawTools() {
  const slot = (key, n, name, own, sel, extra = '') => `<button class="slot ${own ? 'own' : ''} ${sel ? 'sel' : ''} ${extra}" data-tool="${key || ''}" tabindex="-1"><i>${n}</i><span class="ic">${key ? TOOL_ICON[key] : '✋'}</span><em>${name}</em></button>`;
  $('#tools').innerHTML = slot(null, 0, 'Mãos', true, !S.sel) + TOOL_LIST.map(([k, n], i) => slot(k, i + 1, n, S.tools[k], S.sel === k || (k === 'flash' && S.flashOn), k === 'flash' && S.flashOn ? 'lit' : '')).join('') + `<div class="glove ${S.gloves ? 'on' : ''}" title="Luvas isolantes">🧤<em>${S.gloves ? 'Luvas' : 'Sem luvas'}</em></div>`;
}
const STEP_DEFS = [['Pegar as luvas isolantes', () => S.gloves], ['Pegar chave de fenda e lanterna', () => S.tools.screw && S.tools.flash], ['Abrir a tampa dos fusíveis', () => S.bay], ['Trocar o fusível F2', () => S.fuse >= 3], ['Ligar o GERAL', () => S.prog >= 1], ['Ligar os 4 aparelhos na ordem', () => S.prog >= 5]];
function drawJournal() {
  const steps = STEP_DEFS.map(([n, f]) => `<li class="${f() ? 'done' : ''}">${n}</li>`).join('');
  const clues = ['a', 'b', 'c'].map(id => S.read[id] ? `<div class="clue"><img src="${iconURL(CIRC[S.clues[id].a].icon, hexCss(CIRC[S.clues[id].a].col))}"><img class="ar" src="${iconURL('arrow', '#ffffff')}"><img src="${iconURL(CIRC[S.clues[id].b].icon, hexCss(CIRC[S.clues[id].b].col))}"><p><b>${S.clues[id].author}</b>${S.clues[id].short}</p></div>` : `<div class="clue blank"><p>Pista ainda não encontrada</p></div>`).join('') + (S.read.s ? '<div class="clue"><img src="' + iconURL('main', '#e8554e') + '"><p><b>Aviso do eletricista</b>O GERAL liga sempre primeiro.</p></div>' : '');
  const slots = [0, 1, 2, 3].map(i => `<button class="gslot" data-slot="${i}">${S.guess[i] ? `<img src="${iconURL(CIRC[S.guess[i]].icon, hexCss(CIRC[S.guess[i]].col))}"><span>${CIRC[S.guess[i]].nome}</span>` : `<b>${i + 2}º</b>`}</button>`).join('');
  const chips = BRANCHES.map(k => `<button class="chip ${S.guess.includes(k) ? 'used' : ''}" data-chip="${k}"><img src="${iconURL(CIRC[k].icon, hexCss(CIRC[k].col))}">${CIRC[k].nome}</button>`).join('');
  $('#jBody').innerHTML = `<section><h3>Missão</h3><ul class="steps">${steps}</ul></section><section><h3>Pistas</h3>${clues}</section><section><h3>Minha ordem</h3><p class="mini">Monte seu palpite: clique nos aparelhos para colocá-los em ordem.</p><div class="gboard"><div class="gslot fixed"><img src="${iconURL('main', '#e8554e')}"><span>Geral</span></div>${slots}</div><div class="chips">${chips}</div></section>`;
}
function toggleJournal() {
  S.journal = !S.journal; $('#journal').classList.toggle('on', S.journal);
  if (S.journal) { drawJournal(); if (document.pointerLockElement) { G.noPause = true; document.exitPointerLock(); setTimeout(() => G.noPause = false, 200); } SFX.fx.click(); } else { lockReq(); SFX.fx.click(); }
}
$('#jBody').addEventListener('click', e => {
  const chip = e.target.closest('[data-chip]'), slot = e.target.closest('[data-slot]');
  if (chip && !S.guess.includes(chip.dataset.chip)) { const i = S.guess.findIndex(x => !x); if (S.guess.filter(Boolean).length < 4) { if (i >= 0) S.guess[i] = chip.dataset.chip; else S.guess.push(chip.dataset.chip); } SFX.fx.click(); }
  if (slot) { S.guess[+slot.dataset.slot] = null; while (S.guess.length && !S.guess[S.guess.length - 1]) S.guess.pop(); SFX.fx.click(); }
  drawJournal();
});
$('#jClose').onclick = () => toggleJournal();
$('#tools').addEventListener('click', e => { const b = e.target.closest('.slot'); if (b && live()) { const k = b.dataset.tool || null; if (k === 'flash') toggleFlash(); else selectTool(k); } });

function pauseGame() { if (!S.running || S.paused) return; S.paused = true; primary = false; holdInt = null; SFX.Radio.pause(true); show('pause'); if (document.pointerLockElement) document.exitPointerLock(); }
function resumeGame() { S.paused = false; SFX.Radio.pause(false); show(null); $('#hud').classList.remove('hide'); lockReq(); }
function startGame() {
  SFX.init(); SFX.Radio.load(); newRun(); S.running = true; show(null); $('#hud').classList.remove('hide'); drawTools(); lockReq();
  SFX.Music.setMood('dark'); G.mood = 'dark'; G.catHappy = 0;
  setTimeout(() => { if (S.running && !S.done) say('Miau! Apagão no bairro! Eu sou o Fusível. Ajude a vovó a religar a casa: comece pegando as luvas no armário roxo, à direita.', 7500); }, 1200);
  G.yaw = 0; G.pitch = 0; G.px = 0; G.pz = 2.2; $('#journal').classList.remove('on'); closeCard();
}
function toMenu() { S.running = false; S.paused = false; if (document.pointerLockElement) document.exitPointerLock(); newRun(); SFX.Music.setMood('menu'); G.mood = 'menu'; SFX.Radio.on && SFX.Radio.toggle(); show('menu'); }

/* telas */
let prevScreen = 'menu';
$('#btnPlay').onclick = startGame; $('#btnHow').onclick = () => { prevScreen = G.screen; show('how'); }; $('#btnOpts').onclick = () => { prevScreen = G.screen; show('opts'); };
$('#pOpts').onclick = () => { prevScreen = 'pause'; show('opts'); }; $('#pHow').onclick = () => { prevScreen = 'pause'; show('how'); };
$$('.back').forEach(b => b.onclick = () => show(prevScreen || 'menu'));
$('#btnResume').onclick = resumeGame; $('#btnRestart').onclick = () => { startGame(); }; $('#btnMenu').onclick = toMenu;
$('#btnAgain').onclick = startGame; $('#btnEndMenu').onclick = toMenu; $('#cardClose').onclick = closeCard;
function bindOpts() {
  const sv = () => { try { localStorage.setItem('voltaluz.opt', JSON.stringify(Opt)); } catch (e) { } };
  $('#optMus').value = SFX.st.musVol * 100; $('#optSfx').value = SFX.st.sfxVol * 100; $('#optQ').value = Opt.quality;
  ['bob', 'sparkles', 'auto'].forEach(k => { const el = $('#opt_' + k); el.checked = Opt[k]; el.onchange = () => { Opt[k] = el.checked; sv(); }; });
  $('#optMus').oninput = e => SFX.setMus(e.target.value / 100); $('#optSfx').oninput = e => { SFX.setSfx(e.target.value / 100); SFX.fx.click(); };
  $('#optQ').onchange = e => { Opt.quality = e.target.value; sv(); R.scale = 1; R.setQuality(Opt.quality); };
}
// toque (celular): direcional virtual à esquerda, olhar à direita, botões
if (touchMode) {
  let sId = null, lId = null, sOrg = null, lLast = null;
  addEventListener('touchstart', e => { if (!live()) return; for (const t of e.changedTouches) { if (t.target.closest('button,.slot')) continue; if (t.clientX < innerWidth * 0.45 && sId === null) { sId = t.identifier; sOrg = [t.clientX, t.clientY]; } else if (lId === null) { lId = t.identifier; lLast = [t.clientX, t.clientY]; } } }, { passive: true });
  addEventListener('touchmove', e => { for (const t of e.changedTouches) { if (t.identifier === sId) { touch.x = clamp((t.clientX - sOrg[0]) / 50, -1, 1); touch.y = clamp((t.clientY - sOrg[1]) / 50, -1, 1); } else if (t.identifier === lId) { look((t.clientX - lLast[0]) * 1.6, (t.clientY - lLast[1]) * 1.6); lLast = [t.clientX, t.clientY]; } } }, { passive: true });
  addEventListener('touchend', e => { for (const t of e.changedTouches) { if (t.identifier === sId) { sId = null; touch.x = touch.y = 0; } if (t.identifier === lId) lId = null; } }, { passive: true });
  const hold = (id, d, u) => { const el = $(id); el.addEventListener('touchstart', e => { e.preventDefault(); d(); }, { passive: false }); el.addEventListener('touchend', e => { e.preventDefault(); u && u(); }, { passive: false }); };
  hold('#tAct', () => actionDown(false), actionUp);
  hold('#tTool', () => { const list = [null, ...TOOL_LIST.map(t => t[0]).filter(k => k !== 'flash' && S.tools[k])]; selectTool(list[(list.indexOf(S.sel) + 1) % list.length]); });
  hold('#tFlash', toggleFlash); hold('#tHint', giveHint); hold('#tJournal', toggleJournal);
  lookFail = true;
}

/* ---------- atualização do jogo ---------- */
function updateGame(dt, time) {
  const cam = G.cam;
  // câmera
  if (S.running && !S.paused) { if (live()) movePlayer(dt); else { G.vx *= 0.9; G.vz *= 0.9; } }
  if (S.running) {
    const bob = Opt.bob ? Math.sin(G.bob) * 0.018 : 0, shk = S.shk > 0 ? S.shk * 0.04 : 0;
    cam.pos = [G.px + rr(-shk, shk), 1.62 + bob + rr(-shk, shk), G.pz];
    cam.fwd = [-Math.sin(G.yaw) * Math.cos(G.pitch), Math.sin(G.pitch), -Math.cos(G.yaw) * Math.cos(G.pitch)];
  } else {            // câmera de vitrine no menu: passeio lento pela sala escura
    const a = time * 0.12; cam.pos = [1.3 + Math.sin(a) * 1.0, 1.65 + Math.sin(a * 1.7) * 0.05, 2.3];
    cam.fwd = V3.norm(V3.sub([-0.6 + Math.sin(a * 0.7) * 0.5, 1.45, -2.8], cam.pos));
    if (Math.random() < dt * 0.25) { G.sparks([BREAKER_X.vent, 1.3, -2.7], 12); SFX.Ambience && 0; }
  }
  const right = V3.norm(V3.cross(cam.fwd, [0, 1, 0])), up = V3.cross(right, cam.fwd);

  if (S.running && !S.paused && !S.journal) {
    if (!S.done) S.t += dt;
    // ---- mira ----
    G.hover = live() ? pickAim() : null;
    INTS.forEach(it => { if (it.obj) it.obj.hi = damp(it.obj.hi, it === G.hover ? 1 : 0, 14, dt); });
    const info = G.hover ? G.hover.info(S.sel) : null;
    $('#prompt').textContent = S.sel === 'extintor' && S.fire && !info ? 'Segure o clique para espirrar CO₂ no fogo' : info ? info.label : '';
    $('#prompt').classList.toggle('on', !!($('#prompt').textContent));
    if (G.hover && G.hover.id === 'fuse' && S.flashOn && S.bay) S.fuseSeen = true;
    // ---- segurar (parafusar, retirar...) ----
    if (holdInt && primary) {
      const inf = holdInt.info(S.sel);
      if (!inf || !inf.hold || G.hover !== holdInt) actionUp();
      else {
        holdT += dt; holdSfx -= dt; if (holdSfx <= 0) { holdSfx = 0.5; if (inf.sfx === 'screw') SFX.fx.screw(); if (inf.sfx === 'snip') SFX.fx.snip(); }
        const p = clamp(holdT / inf.hold, 0, 1); $('#ring').classList.add('on'); $('#ringC').style.strokeDashoffset = (1 - p) * 113;
        if (p >= 1) { const fn = inf.fn; actionUp(); primary = false; fn(); }
      }
    } else $('#ring').classList.remove('on');
    // ---- extintor ----
    G.spray = primary && S.sel === 'extintor' && S.tools.extintor && live();
    if (G.spray) {
      const o = V3.add(V3.add(V3.add(cam.pos, V3.mul(right, 0.18)), V3.mul(up, -0.14)), V3.mul(cam.fwd, 0.5));
      for (let i = 0; i < 6; i++) PB.emit({ p: o.slice(), v: V3.add(V3.mul(cam.fwd, rr(4, 6)), rv(0.5)), life: rr(0.5, 0.9), s0: 0.06, s1: 0.4, c0: [0.95, 0.98, 1, 0.85], c1: [0.9, 0.95, 1, 0], drag: 1.6, g: -0.2 });
      if (S.fire) { const fb = { min: [-2.9, 0.7, -3.1], max: [-1.8, 1.5, -2.2] }, t = rayBox(cam.pos, cam.fwd, fb); if (t !== null && t < 4.2) { S.fireHP -= dt; if (S.fireHP <= 0) { S.fire = false; S.fireDoor = 0; S.fireT = 0; SFX.fx.good(); toast('Fogo apagado! O CO₂ não deixa o fogo respirar.', 'good'); for (let i = 0; i < 30; i++) PB.emit({ p: V3.add(W.lights.microFire, rv(0.15)), v: [rr(-0.3, 0.3), rr(0.4, 1.0), rr(-0.3, 0.3)], life: 2, s0: 0.2, s1: 0.7, c0: [0.2, 0.2, 0.22, 0.5], c1: [0.1, 0.1, 0.12, 0] }); } } }
    }
    SFX.ext = SFX.ext || SFX.noiseLoop({ bp: 2600, q: 0.5 }); SFX.ext.set(G.spray ? 0.1 : 0);
    // ---- fogo e sprinklers ----
    if (S.fire) {
      S.fireT += dt; const f = W.lights.microFire;
      for (let i = 0; i < 3; i++) PA.emit({ p: [f[0] + rr(-0.12, 0.12), f[1] + rr(-0.05, 0.1), f[2] + rr(-0.08, 0.08)], v: [rr(-0.2, 0.2), rr(0.8, 1.8), rr(-0.2, 0.3)], life: rr(0.5, 0.9), s0: 0.32, s1: 0.06, c0: [3, 1.2, 0.2, 0.9], c1: [0.8, 0.1, 0, 0] });
      if (Math.random() < 0.5) PB.emit({ p: [f[0], f[1] + 0.2, f[2]], v: [rr(-0.2, 0.2), rr(0.6, 1.2), rr(-0.1, 0.3)], life: 2, s0: 0.15, s1: 0.5, c0: [0.12, 0.12, 0.14, 0.45], c1: [0.1, 0.1, 0.12, 0] });
      if (Math.random() < dt * 8) SFX.noise(0.05, { vol: 0.08, hp: 2500 });
      if (S.fireT > 10 && !S.spr) sprinklers();
    }
    if (S.spr > 0) {
      S.spr -= dt; W.lights.sprinklers.forEach(p => { for (let i = 0; i < 6; i++) PB.emit({ p: [p[0], p[1], p[2]], v: [rr(-0.9, 0.9), rr(-1, 0), rr(-0.9, 0.9)], life: 1.5, s0: 0.05, s1: 0.05, c0: [0.65, 0.82, 1, 0.7], c1: [0.65, 0.82, 1, 0.7], g: 7, floor: true }); });
      if (S.spr <= 0) { S.wet = 10; toast('Sprinklers desligados. O quadro continua molhado: use as luvas!', 'warn'); }
    } else if (S.wet > 0) S.wet -= dt;
    G.rain = G.rain || SFX.noiseLoop({ hp: 1500 }); G.rain.set(S.spr > 0 ? 0.08 : 0);
    S.shk = Math.max(0, S.shk - dt); S.blown = Math.max(0, S.blown - dt); S.crazy = Math.max(0, S.crazy - dt); S.fridgeOpen = Math.max(0, S.fridgeOpen - dt); S.meter = Math.max(0, S.meter - dt); S.flashSpark = Math.max(0, S.flashSpark - dt * 3);
    if (S.done) { S.endT -= dt; if (S.endT <= 0 && S.running) endScreen(); }
  }
  G.catHappy = Math.max(0, G.catHappy - dt);

  // ---- estado visual dos objetos ----
  const geral = !!S.on.geral && S.fuse >= 3, P = W.panel;
  const lightsWant = geral && S.on.luz && S.blown <= 0 ? 1 : 0;
  if (lightsWant && !S.roomOn) { S.flick = 0.9; SFX.fx.lightOn(); } S.roomOn = !!lightsWant; S.flick = Math.max(0, (S.flick || 0) - dt);
  S.lp = damp(S.lp, lightsWant, lightsWant ? 8 : 20, dt); const lp = S.lp * (S.flick > 0 && Math.random() < 0.5 ? 0.35 : 1);
  W.lamps.forEach(l => l.power = lp); W.floorLamp.power = lp; W.shafts.power = 0.3 * (1 - 0.95 * S.lp);
  Object.keys(CIRC).forEach(k => {
    const tgt = S.on[k] ? 0.45 : (S.lever[k] > 0 && !S.on[k] ? -0.45 : -0.45); S.lever[k] = damp(S.lever[k], tgt, 14, dt);
    P.levers[k].rot[0] = S.lever[k]; P.leds[k].power = damp(P.leds[k].power, S.on[k] && geral ? 1 : (S.on[k] ? 0.4 : 0), 10, dt);
    P.leds[k].tint = S.errPulse ? [1, 0.2, 0.2] : [0.4, 1, 0.5];
  });
  P.ledMain.power = geral ? 1 : (S.fuse >= 3 ? 0.5 + 0.5 * Math.sin(time * 5) : 0); P.ledMain.tint = geral ? [0.3, 1, 0.5] : [1, 0.5, 0.2];
  const f2 = P.fuses[1]; if (S.fuse >= 2) { f2.tint = S.fuse === 3 ? [0.8, 1, 0.85] : [1, 1, 1]; f2.rot[2] = S.fuse === 2 ? 0.14 + Math.sin(time * 9) * 0.015 : 0; } f2.update();
  W.fan.rot[1] += dt * (geral && S.on.vent ? (S.crazy > 0 ? 16 : 7) : S.crazy > 0 ? 16 : 0);
  W.fan.update();
  const fOpen = S.fridgeOpen > 0; W.fridge.door.rot[1] = damp(W.fridge.door.rot[1], fOpen ? -1.4 : 0, 7, dt);
  W.fridge.inside.power = damp(W.fridge.inside.power, fOpen && geral ? 1 : 0, 10, dt); W.fridge.inside.visible = fOpen || W.fridge.door.rot[1] < -0.05;
  W.micro.door.rot[1] = damp(W.micro.door.rot[1], S.fire ? -1.6 : 0, 7, dt);
  const mp = geral && S.on.micro; W.micro.display.power = mp ? 0.6 + 0.4 * Math.sin(time * 3) : 0; W.micro.inner.power = mp || S.fire ? 1 : 0; if (mp) W.micro.plate.rot[1] += dt * 2.5;
  W.cabinet.doorL.rot[1] = damp(W.cabinet.doorL.rot[1], S.cabinetOpen ? -1.75 : 0, 6, dt); W.cabinet.doorR.rot[1] = damp(W.cabinet.doorR.rot[1], S.cabinetOpen ? 1.75 : 0, 6, dt);
  W.puddle.alpha = damp(W.puddle.alpha, S.spr > 0 ? 0.42 : Math.max(0, S.wet / 10) * 0.32, 4, dt);
  W.city.power = damp(W.city.power, S.done ? 1 : 0, 0.55, dt); W.city.blink.power = Math.sin(time * 3) > 0.2 ? 1 : 0.05; W.city.gen.power = 0.7 + 0.3 * Math.sin(time * 1.3);
  W.emergLed.power = (Math.sin(time * 4) > 0 ? 1 : 0.1) * (1 - S.lp); W.exitFace.power = 1;
  const ca = W.cat, cx = ca.root.pos[0], cz = ca.root.pos[2], want = Math.atan2(-(G.px - cx), -(G.pz - cz));
  let d = want - ca.root.rot[1]; d = Math.atan2(Math.sin(d), Math.cos(d)); ca.root.rot[1] += d * Math.min(1, dt * 3);
  ca.head.rot[0] = Math.sin(time * 0.7) * 0.05 - G.pitch * 0.2; ca.head.rot[2] = Math.sin(time * 0.5) * 0.06;
  ca.root.pos[1] = 0.38 + (G.catHappy > 0 ? Math.abs(Math.sin(time * 9)) * 0.03 : 0);
  ca.tail.forEach((t, i) => t.rot[2] = 0.25 + Math.sin(time * (G.catHappy > 0 ? 7 : 1.8) + i * 0.7) * (G.catHappy > 0 ? 0.3 : 0.14));
  const blink = (time % 4.2) < 0.13; ca.eyes.concat(ca.pupils).forEach(o => o.visible = !blink);
  W.radio.screen.update();
  W.objs.forEach(o => { if (!o.fixed) o.update(); }); W.city.blink.update();

  // ---- viewmodel ----
  const vmList = []; G.vmObjs = vmList;
  if (S.running && S.sel && W.toolMeshes[S.sel] && S.tools[S.sel] && !S.done) {
    const o = G.vm[S.sel] || (G.vm[S.sel] = new Obj(W.toolMeshes[S.sel], { spec: 0.3 })); const use = (G.spray || (holdInt && primary)) ? Math.sin(time * 22) * 0.012 : 0;
    const k = { extintor: [0.3, -0.34, 0.66], multi: [0.2, -0.2, 0.42], screw: [0.2, -0.17, 0.45], pliers: [0.2, -0.17, 0.45] }[S.sel];
    const bob = Math.sin(G.bob) * 0.006 + use;
    o.pos = V3.add(V3.add(V3.add(cam.pos, V3.mul(right, k[0])), V3.mul(up, k[1] + bob)), V3.mul(cam.fwd, k[2]));
    o.rot = [G.pitch + (S.sel === 'multi' ? 0.25 : 0.1), G.yaw + (S.sel === 'extintor' ? 0 : -0.12), S.sel === 'multi' ? -0.1 : 0];
    if (S.sel === 'multi') o.rot[1] += 0; o.update(); vmList.push(o);
  }
  // ---- partículas de ambiente / guia ----
  G.acc = (G.acc || 0) + dt;
  if (S.running && G.acc > 0.3) {
    G.acc = 0; const ob = objective();
    if (Opt.sparkles && live()) ob.g.forEach(p => G.sparkle(p));
  }
  if (Math.random() < dt * 5) PA.emit({ p: [rr(-3, 0), rr(0.8, 2.2), rr(-1.4, 1.2)], v: rv(0.04), life: 7, s0: 0.011, s1: 0.011, c0: [0.5, 0.65, 1, 0.0], c1: [0.5, 0.65, 1, 0.5] });
  G.parts.forEach(p => p.update(dt));
  if (S.running) { const ob = objective(); $('#objT').textContent = ob.t; $('#objW').textContent = ob.w; $('#timer').textContent = fmtTime(S.t); $('#errs').textContent = S.errors; $('#hints').textContent = S.hints; $('#meter').classList.toggle('on', S.meter > 0); }
  G.right = right; G.up = up;
}
function sprinklers() {
  S.spr = 8; S.fire = false; S.fireDoor = 0; S.on = {}; S.prog = 0; S.t += 20; S.errors++; SFX.fx.bad(); G.rainSfx = 1;
  toast('Os sprinklers apagaram o fogo e desarmaram tudo! +20 s. Quadro molhado: só mexa com luvas.', 'bad'); say('Miau! A água apagou o fogo, mas derrubou os disjuntores. Recomece a ordem!', 5500);
}

/* ---------- ambiente (luzes e cores) por quadro ---------- */
const ENV = { pl: [], spot: { on: 0, p: [0, 0, 0], d: [0, 0, -1], c: [3, 3, 2.6], cone: [0.96, 0.86] }, flash: [1, 1, 1, 0] };
function buildEnv(time) {
  const e = ENV, lp = S.lp, cam = G.cam, mx = (a, b) => [lerp(a[0], b[0], lp), lerp(a[1], b[1], lp), lerp(a[2], b[2], lp)];
  e.time = time; e.sky = mx([0.11, 0.14, 0.27], [0.2, 0.16, 0.17]); e.ground = mx([0.055, 0.055, 0.1], [0.12, 0.08, 0.06]);
  e.d0 = V3.norm([-0.75, 0.46, 0.3]); e.c0 = dimC([0.5, 0.72, 1.4], 1 - 0.6 * lp); e.d1 = V3.norm([0.16, 1, 0.1]); e.c1 = dimC([1.0, 0.74, 0.48], 0.5 * lp);
  e.fog = mx([0.03, 0.05, 0.11], [0.05, 0.05, 0.09]); e.fogD = 0.014; e.rim = dimC([0.08, 0.12, 0.28], 1 - 0.7 * lp);
  e.skyHor = [0.05 + W.city.power * 0.08, 0.08 + W.city.power * 0.05, 0.19]; e.skyZen = [0.012, 0.022, 0.065]; e.moonDir = e.d0; e.cityGlow = W.city.power; e.stars = 1;
  const L = W.lights, pl = []; e.pl = pl;
  if (lp > 0.01) { L.lamps.forEach(p => pl.push({ p, r: 6.8, c: dimC([2.6, 1.6, 0.85], lp) })); pl.push({ p: L.floor, r: 4.6, c: dimC([2.2, 1.5, 0.9], lp) }); }
  const geral = S.on.geral && S.fuse >= 3;
  if (W.fridge.inside.power > 0.05) pl.push({ p: L.fridge, r: 2.8, c: [1.1, 1.5, 1.9].map(v => v * W.fridge.inside.power) });
  if (geral && S.on.micro) pl.push({ p: L.micro, r: 2.2, c: [1.0, 0.8, 0.5] });
  if (lp < 0.9) pl.push({ p: L.emerg, r: 4.2, c: [0.6, 0.05, 0.04].map(v => v * (Math.sin(time * 4) > 0 ? 1 : 0.15) * (1 - lp)) });
  if (S.fire) pl.push({ p: [L.microFire[0], 1.2, L.microFire[2] + 0.3], r: 4.5, c: [3.2, 1.3, 0.3].map(v => v * (0.8 + 0.3 * Math.sin(time * 30))) });
  if (S.flashSpark > 0) pl.push({ p: [0, 1.5, -2.5], r: 4.5, c: [2.4, 2.7, 3.6].map(v => v * S.flashSpark) });
  if (S.done) pl.push({ p: [0, 2.4, 0], r: 8, c: [1.2, 1.0, 0.8] });
  const sp = e.spot, on = S.running && S.flashOn && S.tools.flash ? 1 : 0; sp.on = damp(sp.on, on, 25, 0.016);
  sp.p = V3.add(V3.add(cam.pos, V3.mul(G.right || [1, 0, 0], 0.14)), V3.mul(G.up || [0, 1, 0], -0.08)); sp.d = cam.fwd;
  e.exposure = 1.3 - 0.22 * lp; e.bloom = 0.55; e.bloomThr = 1.0; e.vig = 0.5; e.grain = 0.03; e.sat = 1.12 + 0.05 * lp;
  e.warp = S.shk > 0 ? S.shk : 0; e.wetScreen = S.spr > 0 || S.wet > 0 ? 0.55 : 0; e.flash = S.shk > 0 ? [1, 0.95, 0.7, S.shk * 0.5] : [0, 0, 0, 0];
  return e;
}

/* ---------- laço principal ---------- */
let last = 0, fpsAcc = 0, fpsN = 0, slowT = 0, fastT = 0;
function frame(ms) {
  requestAnimationFrame(frame);
  const time = ms / 1000, dt = Math.min(time - last, 0.05); last = time;
  if (document.hidden || dt <= 0) return;
  R.resize(); updateGame(dt, time);
  const env = buildEnv(time);
  R.frame({ objs: W.objs.concat([W.city, W.city.blink, W.city.gen]).filter((o, i, a) => a.indexOf(o) === i), vmObjs: G.vmObjs || [], parts: G.parts, env, cam: G.cam });
  // mood da trilha
  const mood = !S.running ? 'menu' : S.done ? 'party' : S.lp > 0.5 ? 'bright' : 'dark';
  if (mood !== G.mood) { G.mood = mood; if (!SFX.Radio.on) SFX.Music.setMood(mood); }
  // resolução dinâmica
  if (Opt.auto) { fpsAcc += dt; fpsN++; if (fpsAcc > 1) { const avg = fpsAcc / fpsN; fpsAcc = 0; fpsN = 0;
    if (avg > 1 / 40) { slowT++; fastT = 0; } else if (avg < 1 / 57) { fastT++; slowT = 0; } else { slowT = fastT = 0; }
    if (slowT >= 2 && R.scale > 0.55) { R.scale = Math.max(0.55, R.scale - 0.1); R.resize(true); slowT = 0; }
    if (fastT >= 6 && R.scale < R.pre.maxScale) { R.scale = Math.min(R.pre.maxScale, R.scale + 0.05); R.resize(true); fastT = 0; } } }
}

/* ---------- mural de desenhos (usa a pasta desenhos/ se existir; senão, giz de cera procedural) ---------- */
function addMural() {
  const files = ['julia.webp', 'pedro.png', 'sofia.jpg'], xs = [-3.1, -2.5, -1.9];
  files.forEach((f, i) => {
    const ct = new CanvasTex(256, 192), g = ct.g, r = mulberry32(i * 31 + 5);
    g.fillStyle = '#fff6df'; g.fillRect(0, 0, 256, 192);
    g.lineWidth = 7; g.lineCap = 'round';
    [['#ffb300', 'sun'], ['#e8554e', 'house'], ['#2f9ea0', 'cat']][i] && (() => {
      const k = ['sun', 'house', 'cat'][i]; g.strokeStyle = ['#ffb300', '#e8554e', '#2f9ea0'][i];
      if (k === 'sun') { g.beginPath(); g.arc(128, 90, 34, 0, TAU); g.stroke(); for (let a = 0; a < 10; a++) { g.beginPath(); g.moveTo(128 + Math.cos(a * 0.628) * 46, 90 + Math.sin(a * 0.628) * 46); g.lineTo(128 + Math.cos(a * 0.628) * 66, 90 + Math.sin(a * 0.628) * 66); g.stroke(); } g.strokeStyle = '#4caf50'; g.beginPath(); g.moveTo(10, 170); g.lineTo(246, 170); g.stroke(); }
      if (k === 'house') { g.strokeRect(70, 80, 116, 80); g.beginPath(); g.moveTo(60, 82); g.lineTo(128, 30); g.lineTo(196, 82); g.stroke(); g.strokeStyle = '#6b4a8a'; g.strokeRect(112, 114, 32, 46); }
      if (k === 'cat') { g.beginPath(); g.arc(128, 104, 46, 0, TAU); g.stroke(); g.beginPath(); g.moveTo(92, 72); g.lineTo(86, 32); g.lineTo(118, 58); g.moveTo(164, 72); g.lineTo(170, 32); g.lineTo(138, 58); g.stroke(); g.fillStyle = '#2f9ea0'; g.beginPath(); g.arc(110, 100, 5, 0, TAU); g.arc(146, 100, 5, 0, TAU); g.fill(); g.beginPath(); g.moveTo(118, 122); g.quadraticCurveTo(128, 134, 138, 122); g.stroke(); }
    })();
    ct.upload();
    const b = new MeshBuilder(1); b.box(0, 0, -0.01, 0.56, 0.44, 0.014, C(0xf3ecd9), { ao: 1, j: 0 }); b.box(0, 0.21, 0.0, 0.14, 0.035, 0.012, [C(0xe7c960), C(0x8dc8b4), C(0xe59c83)][i], { ao: 1, j: 0 });
    const frame = new Obj(b.build(), { pos: [xs[i], 1.78, 2.97], rot: [0, Math.PI, 0], cast: 0, fixed: true });
    const pb = new MeshBuilder(1); pb.plane(0, 0, 0, 0.5, 0.38, [1, 1, 1], { ao: 1 });
    const pic = new Obj(pb.build(), { pos: [xs[i], 1.78, 2.955], rot: [0, Math.PI, 0], map: ct.tex, cast: 0, fixed: true });
    W.objs.push(frame, pic);
    // tenta trocar pelo desenho real (só funciona servindo por http; em file:// o navegador bloqueia, e ficamos com o giz de cera)
    const img = new Image(); img.onload = () => { try { const a = img.width / img.height, w = 256, h = 192; g.fillStyle = '#fff6df'; g.fillRect(0, 0, w, h); let dw = w, dh = w / a; if (dh > h) { dh = h; dw = h * a; } g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh); ct.upload(); } catch (e) { /* mantém o desenho procedural */ } };
    img.src = 'desenhos/' + f;
  });
}

/* ---------- inicialização ---------- */
(async function boot() {
  try {
    try { await Promise.race([document.fonts.load('700 20px "Baloo 2"'), document.fonts.load('700 20px "Caveat"'), new Promise(r => setTimeout(r, 1500))]); } catch (e) { }
    R = new Renderer(); Opt.quality = Opt.quality || 'alta'; R.setQuality(Opt.quality);
    W = buildWorld(); addMural(); setupInteractions(); newRun(); bindOpts(); drawTools();
    W.objs.forEach(o => o.update());
    addEventListener('resize', () => R.resize());
    show('menu'); SFX.Music.mood = 'menu';
    const best = Best; if (best) $('#menuBest').textContent = `Melhor marca: ${fmtTime(best.t)} · ${best.stars} ${best.stars > 1 ? 'estrelas' : 'estrela'}`;
    document.body.classList.add('ready'); requestAnimationFrame(frame);
    window.__game = { S, W, R, G, ENV, INTS, startGame, newRun, pressBreaker, objective, updateGame };   // útil para depuração no console
  } catch (err) { console.error(err); $('#fatal').textContent = 'Erro ao iniciar: ' + err.message; $('#fatal').classList.add('on'); }
})();
