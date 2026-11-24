/* Fondo de la web: líneas tipo mapa topográfico que se mueven muy despacio, muy de fondo.
   WebGL en un <canvas> fijo detrás de todo. Ligero: resolución reducida, ~30 fps, se para con la
   pestaña oculta y queda quieto con «reducir movimiento». Sin WebGL no hace nada (queda el negro). */
(function () {
  'use strict';
  var cfg = window.HZ_TOPO || {};
  var canvas = document.createElement('canvas');
  canvas.id = 'hz-topo';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;opacity:0;transition:opacity 1.2s ease';
  var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl || !gl.getExtension('OES_standard_derivatives')) return;
  document.body.prepend(canvas);
  document.documentElement.classList.add('has-topo');

  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FS = [
    '#extension GL_OES_standard_derivatives : enable',
    'precision mediump float;',
    'uniform vec2 R;uniform float T;uniform vec3 C;uniform float A;uniform float N;',
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
    ' vec2 uv=gl_FragCoord.xy/R.y;',
    ' float t=T*.012;',          // muy lento
    ' vec2 q=uv*.7+vec2(sn(uv*.4+t*.6),sn(uv*.4-t*.5+7.3))*.25;',       // un poco de remolino, como el vídeo
    ' float h=sn(q+vec2(t,-t*.7))*.65+sn(q*2.1-vec2(t*.8,t*.4)+3.1)*.35;',
    ' float v=h*N;',
    ' float d=abs(fract(v-.5)-.5)/max(fwidth(v),1e-4);',
    ' float line=1.-min(d/1.25,1.);',
    ' float major=step(.5,fract(floor(v)*.5+.25))*.6+.4;',               // una línea más clara de cada dos
    ' vec2 c=gl_FragCoord.xy/R-.5;float vig=1.-smoothstep(.25,.85,length(c*vec2(1.,.9)));',
    ' float k=line*major*A*(.55+.45*vig);',
    ' gl_FragColor=vec4(C*k,k);}'
  ].join('\n');
  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
  var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) { canvas.remove(); document.documentElement.classList.remove('has-topo'); return; }
  var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { canvas.remove(); document.documentElement.classList.remove('has-topo'); return; }
  gl.useProgram(pr);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uR = gl.getUniformLocation(pr, 'R'), uT = gl.getUniformLocation(pr, 'T'), uC = gl.getUniformLocation(pr, 'C'), uA = gl.getUniformLocation(pr, 'A'), uN = gl.getUniformLocation(pr, 'N');

  // color: blanco, o el de la web (--accent-color-rgb) si se pide; se puede cambiar luego (HZ_TOPO_SET)
  var color = [1, 1, 1], alpha = cfg.alpha || 0.045, lines = cfg.lines || 7;
  function readColor() {
    if (cfg.color !== 'accent') { color = [1, 1, 1]; return; }
    var v = getComputedStyle(document.documentElement).getPropertyValue('--accent-color-rgb') || getComputedStyle(document.body).getPropertyValue('--accent-color-rgb');
    var m = String(v).match(/(\d+)\D+(\d+)\D+(\d+)/);
    color = m ? [m[1] / 255, m[2] / 255, m[3] / 255] : [1, 1, 1];
  }
  window.HZ_TOPO_SET = function (o) { for (var k in o) cfg[k] = o[k]; alpha = cfg.alpha || alpha; lines = cfg.lines || lines; readColor(); draw(last); };

  var SCALE = 0.6;   // resolución reducida: las líneas son suaves igual y gasta mucho menos
  function size() {
    var w = Math.max(1, Math.round(innerWidth * SCALE)), h = Math.max(1, Math.round(innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
  }
  var t0 = performance.now(), last = 0;
  function draw(ms) {
    size();
    gl.uniform2f(uR, canvas.width, canvas.height);
    gl.uniform1f(uT, (ms - t0) / 1000 + 40);
    gl.uniform3f(uC, color[0], color[1], color[2]);
    gl.uniform1f(uA, alpha);
    gl.uniform1f(uN, lines);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  var still = matchMedia('(prefers-reduced-motion: reduce)').matches, raf = 0;
  function loop(ms) {
    raf = requestAnimationFrame(loop);
    if (ms - last < 33) return;   // ~30 fps es de sobra para algo tan lento
    last = ms; draw(ms);
  }
  function start() { if (!raf && !still && !document.hidden) raf = requestAnimationFrame(loop); }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });
  addEventListener('resize', function () { if (still || !raf) draw(last); });
  // el color de la web se pone al cargar los datos: se lee un poco después
  readColor(); draw(0); canvas.style.opacity = '1';
  setTimeout(function () { readColor(); draw(last); }, 1500);
  start();
})();
