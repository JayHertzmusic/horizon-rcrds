/* Desenfoque progresivo (arriba, detrás del menú, y abajo del todo): varias capas con blur cada vez más fuerte,
   cada una visible solo en su franja, así el contenido se va difuminando poco a poco al llegar al borde.
   Solo efecto visual: no se puede pulsar (pointer-events: none). Sin backdrop-filter, no hace nada. */
(function () {
  'use strict';
  if (!CSS.supports('backdrop-filter', 'blur(1px)') && !CSS.supports('-webkit-backdrop-filter', 'blur(1px)')) return;
  var N = 6;
  function make(pos, h) {
    var box = document.createElement('div');
    box.className = 'pblur pblur-' + pos;
    box.setAttribute('aria-hidden', 'true');
    box.style.height = h + 'px';
    for (var i = 0; i < N; i++) {
      var l = document.createElement('div'), a = i / N * 100, b = (i + 1) / N * 100, c = (i + 2) / N * 100;
      var dir = pos === 'top' ? 'to top' : 'to bottom';
      // cada capa: transparente → opaca → transparente en su franja (la última llega hasta el borde)
      var m = 'linear-gradient(' + dir + ', transparent ' + a + '%, #000 ' + b + '%' + (i < N - 1 ? ', #000 ' + c + '%, transparent ' + Math.min(100, c + 100 / N) + '%' : '') + ')';
      l.style.cssText = 'position:absolute;inset:0;-webkit-backdrop-filter:blur(' + Math.pow(2, i) * 0.5 + 'px);backdrop-filter:blur(' + Math.pow(2, i) * 0.5 + 'px);-webkit-mask-image:' + m + ';mask-image:' + m;
      box.appendChild(l);
    }
    document.body.appendChild(box);
  }
  document.documentElement.classList.add('has-pblur');
  make('top', 130);
  make('bottom', 90);
})();
