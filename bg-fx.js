/* Fondo de la web (detrás de Releases, Mixtapes, Playlists y el pie): luces muy suaves a los lados,
   cada una del color de la portada que tiene más cerca, y se mueven con la página.
   WebGL en un <canvas> fijo detrás de todo. Ligero: resolución reducida, ~30 fps, se para con la
   pestaña oculta y queda quieto con «reducir movimiento». Sin WebGL no hace nada (queda el negro). */
(function () {
  'use strict';
  var MAXL = 8;
  var canvas = document.createElement('canvas');
  canvas.id = 'hz-fx';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;opacity:0;transition:opacity 1.2s ease';
  var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) return;
  document.body.prepend(canvas);
  document.documentElement.classList.add('has-fx');

  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FS = [
    'precision mediump float;',
    'uniform vec2 R;uniform float T;uniform float A;uniform int LN;uniform vec3 LC[' + MAXL + '];uniform vec3 LP[' + MAXL + '];',
    'vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}vec2 m289(vec2 x){return x-floor(x*(1./289.))*289.;}',
    'vec3 perm(vec3 x){return m289(((x*34.)+1.)*x);}',
    'float sn(vec2 v){const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);',
    'vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);',
    'vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=m289(i);',
    'vec3 p=perm(perm(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));',
    'vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m;m=m*m;',
    'vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;',
    'm*=1.79284291400159-.85373472095314*(a0*a0+h*h);',
    'vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(m,g);}',
    'void main(){',
    ' vec2 px=gl_FragCoord.xy;vec2 uv=px/R.y;float t=T*.015;',
    // las luces respiran y se deforman muy despacio
    ' float a=sn(uv*.55+vec2(t,-t*.7))*.5+.5,b=sn(uv*.9-vec2(t*.6,t*.4)+5.2)*.5+.5;',
    ' float n=.45+.9*a*b;',
    ' vec2 w=vec2(sn(uv*.8+t),sn(uv*.8-t+3.7))*R.y*.06;',
    ' vec3 col=vec3(0.);',
    ' for(int i=0;i<' + MAXL + ';i++){ if(i>=LN) break;',
    '  vec2 d=(px+w-LP[i].xy)/LP[i].z; col+=LC[i]*exp(-dot(d,d)*1.6); }',
    ' col*=n*A;',
    ' float k=max(col.r,max(col.g,col.b));',
    ' gl_FragColor=vec4(col,k);}'
  ].join('\n');
  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
  function bail() { canvas.remove(); document.documentElement.classList.remove('has-fx'); }
  var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return bail();
  var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return bail();
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var U = {}; ['R', 'T', 'A', 'LN', 'LC', 'LP'].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });

  var ALPHA = 0.16;   // muy de fondo
  var SCALE = 0.5;   // las luces son suaves: con media resolución sobra

  /* ── el color de cada portada ── */
  // releases y mixtapes tienen su color (--track-color); las playlists, el color medio de su portada
  var colors = new WeakMap(), probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function hexRgb(h) { h = h.trim().replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); var n = parseInt(h, 16); return isNaN(n) || h.length !== 6 ? null : [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function imgColor(img) {
    try {
      probe.canvas.width = probe.canvas.height = 12; probe.drawImage(img, 0, 0, 12, 12);
      var d = probe.getImageData(0, 0, 12, 12).data, r = 0, g = 0, b = 0, wsum = 0;
      for (var i = 0; i < d.length; i += 4) {   // los píxeles con más color cuentan más
        var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]), w = (mx - mn) / 255 + 0.05;
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
      }
      var c = [r / wsum / 255, g / wsum / 255, b / wsum / 255], top = Math.max(c[0], c[1], c[2]) || 1;
      return c.map(function (v) { return Math.min(1, v / top); });   // a brillo completo: la luz pone la intensidad
    } catch (e) { return null; }
  }
  function cardColor(el) {
    if (colors.has(el)) return colors.get(el);
    var c = hexRgb(el.style.getPropertyValue('--track-color') || '');
    if (!c) { var img = el.querySelector('img'); if (img && img.complete && img.naturalWidth) c = imgColor(img); else return null; }
    colors.set(el, c); return c;
  }

  /* ── luces: a la izquierda y a la derecha, a la altura de las portadas de los extremos ── */
  var lights = [];
  function gather() {
    var vw = innerWidth, vh = innerHeight, out = [];
    var cards = document.querySelectorAll('#releases .release-card, #radio .release-card, #playlists .playlist-card');
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (r.bottom < -vh * 0.5 || r.top > vh * 1.5 || !r.width) continue;
      var cx = (r.left + r.right) / 2, side = cx < vw * 0.3 ? -1 : cx > vw * 0.7 ? 1 : 0;
      if (!side) continue;
      var c = cardColor(cards[i]); if (!c) continue;
      out.push({ x: side < 0 ? Math.max(0, r.left - vw * 0.04) : Math.min(vw, r.right + vw * 0.04), y: (r.top + r.bottom) / 2, c: c, d: Math.abs((r.top + r.bottom) / 2 - vh / 2) });
    }
    out.sort(function (a, b) { return a.d - b.d; });
    lights = out.slice(0, MAXL);
  }

  function size() {
    var w = Math.max(1, Math.round(innerWidth * SCALE)), h = Math.max(1, Math.round(innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  }
  var t0 = performance.now(), last = 0, LC = new Float32Array(MAXL * 3), LP = new Float32Array(MAXL * 3);
  function draw(ms) {
    size(); gather();
    var s = canvas.width / innerWidth, H = canvas.height;
    for (var i = 0; i < lights.length; i++) {
      var L = lights[i];
      LC.set(L.c, i * 3);
      LP.set([L.x * s, H - L.y * s, H * 0.42], i * 3);
    }
    gl.uniform2f(U.R, canvas.width, canvas.height);
    gl.uniform1f(U.T, (ms - t0) / 1000 + 20);
    gl.uniform1f(U.A, ALPHA);
    gl.uniform1i(U.LN, lights.length);
    gl.uniform3fv(U.LC, LC); gl.uniform3fv(U.LP, LP);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  var still = matchMedia('(prefers-reduced-motion: reduce)').matches, raf = 0;
  function loop(ms) {
    raf = requestAnimationFrame(loop);
    if (ms - last < 33) return;
    last = ms; draw(ms);
  }
  function start() { if (!raf && !still && !document.hidden) raf = requestAnimationFrame(loop); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  // quieto («reducir movimiento»): se vuelve a pintar al bajar por la página
  addEventListener('scroll', function () { if (still) draw(last); }, { passive: true });
  addEventListener('resize', function () { if (still || !raf) draw(last); });
  draw(0); canvas.style.opacity = '1';
  start();
})();
