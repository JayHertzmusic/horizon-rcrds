# Panel de HORIZON RCRDS

Un panel para publicar en la web sin tocar código: **releases**, **radio (mixtapes)**, **playlists**, **audio del reproductor** y **logo / icono**.

No necesita servidor ni cuentas nuevas. El panel vive en la carpeta `admin/` de la web y guarda cada cambio directamente en el repositorio de GitHub. GitHub Pages vuelve a publicar la web sola en 1–2 minutos.

## Qué cambia en la web

- **Portada nueva:** el **último release** es el protagonista (título grande, artista, nº de catálogo, reproductor y botones) con su portada flotando en 3D. Encima de ella va una tarjeta con el **último mixtape** de Radio, con su propio reproductor; solo suena uno a la vez.
- **Sección Mixtapes** (enlace «Radio» en el menú) con los 8 últimos, como Releases. «View Full Catalogue →» lleva al catálogo completo, que ahora tiene dos pestañas: **Releases** y **Radio**, cada una con su buscador. Ya están cargados los 10 mixtapes que hay en SoundCloud, del #001 al #010.
- La onda del reproductor tiene la forma real del audio. Parada, «respira» suavemente; sonando, se mueve con la música y se ilumina según avanza. Se puede pulsar en ella para saltar a ese punto.
- El nº de catálogo (HRZ#…) ahora se ve en la portada y en las tarjetas. Antes no salía porque la web lo buscaba con otro nombre.
- Si el título del release es largo, la letra se ajusta sola para que quepa en una línea.
- Scroll suave con la rueda del ratón (Lenis) en la portada y el catálogo. En móvil y táctil, el scroll normal.

## La web se actualiza sola desde SoundCloud

Cada 3 horas, GitHub mira el SoundCloud de Horizon y añade a la web lo nuevo:

- **«HORIZON RCRDS Mixtape #011 | Invitado»** va a **Radio**, con su número, el invitado, la portada, el color y un fragmento de 45 segundos del momento más intenso del mix, que suena en la portada.
- **«Artista - Título»** va a **Releases**, con el siguiente HRZ#, la portada, el color y los enlaces, y pasa a ser el protagonista de la portada. Su drop (30 segundos) pasa a ser el audio del reproductor. Lo que vaya entre corchetes, como «[ADE Sampler 2026]», no aparece en el título.
- Las versiones **«(Extended Mix)»** se ignoran siempre: en la web solo va el release normal.
- Lo demás (IDs, etc.) se ignora.
- **Nunca mira nada anterior a «Kris m - Lights» (HRZ#047, 28 de enero de 2026)**: la web empieza ahí y lo de antes no entra.

**En la descripción de cada release en SoundCloud** poned los enlaces así, cada uno en su línea:

```
Stream / Download: https://too.fm/…
Spotify: https://open.spotify.com/track/…
```

El de SoundCloud se pone solo. Si falta el de Spotify, la web simplemente no muestra ese botón, y en cuanto lo añadáis a la descripción (aunque sea días después) el botón aparece solo. Es lo único que el automático rellena en algo ya publicado, y solo si estaba vacío.

La cuenta que se revisa es **https://soundcloud.com/horizonirecords** (a través de su feed público).

**El automático y el panel conviven:**
- El automático nunca borra ni cambia lo que ya está en la web, así que lo que corrijáis en el panel (título, nº de catálogo, color, enlaces, portada, fragmento, posición) se queda como lo dejéis.
- Podéis seguir añadiendo a mano desde el panel lo que no esté en SoundCloud.
- Lo que **eliminéis** desde el panel queda apuntado en `sync-ignore.json` y el automático **no lo vuelve a poner**, aunque siga en SoundCloud. Si un día queréis recuperarlo, añadidlo a mano desde el panel. También se puede lanzar a mano sin esperar: GitHub → pestaña **Actions** → **Sync SoundCloud** → **Run workflow**.

---

## 1. Publicar (una sola vez)

Todo está listo en esta carpeta: `admin/`, `index.html` con la portada nueva, `mixtapes.json` y las portadas `assets/mix001.jpg` … `mix010.jpg`. `admin/config.js` ya apunta a `JayHertzmusic/horizon-rcrds` (rama `main`).

Haz commit de todo y push, incluida la carpeta oculta `.github/`, que es la que hace la sincronización automática. Si GitHub dice que tu copia está atrasada, haz antes `git pull`.

Después el panel queda en **https://horizonrcrds.com/admin/**.

## 2. Crear el token de GitHub (una vez por navegador o cuando caduque)

1. GitHub → *Settings* → *Developer settings* → *Personal access tokens* → **Fine-grained tokens** → *Generate new token*.
2. **Repository access**: *Only select repositories* → solo el repositorio de la web.
3. **Permissions → Repository permissions → Contents: Read and write**. No hace falta ningún otro permiso.
4. Elige la caducidad, por ejemplo 90 días. Pulsa *Generate token* y pega el token en el panel.

El token se guarda solo en ese navegador. **Salir** lo borra. Marca «Recordar» solo en tu propio ordenador. Nunca lo subas al repositorio ni lo pongas en `config.js`. Ten activada la verificación en dos pasos en GitHub.

## 3. Usarlo

- **Releases**: **+ Nuevo lanzamiento** → arrastra la portada → rellena título, artistas y enlaces → **Publicar**.
  - Sale en la posición 1, es decir, en la portada de la web.
  - La portada se ajusta sola a 1000×1000 en JPG.
  - El color se saca de la portada y se puede cambiar.
  - El nº de catálogo se propone solo (el siguiente HRZ#).
- **Radio**: **+ Nuevo mixtape** → pega el **enlace de SoundCloud** del mixtape. Se rellenan solos el número, el título, el artista invitado, la portada y el color.
  - Sube el **fragmento de audio**: un MP3 corto, de 1 a 2 minutos, que suena en la portada de la web. Si no lo subes, el botón de play abre el mix completo en SoundCloud.
  - **Publicar**. El mixtape nuevo sale arriba, encima de la portada del release.
- **Playlists**: igual (portada, título, descripción, enlace y posición).
- **Reproductor**: sustituye `assets/release_preview.mp3`, el audio del release en la portada.
- **Logo**: sustituye `assets/logo.png` y `assets/favicon_icon.png`. Tienen que ser PNG.
- **Editar** sirve para cambiar cualquier cosa, moverla de posición o eliminarla. Al eliminar algo también se borran sus archivos.

Tras **Publicar**, el panel avisa con «✓ Ya está en la web» cuando la web ya muestra el cambio. Si alguien ya tenía la web abierta, puede tardar hasta 10 minutos en ver el cambio por la caché de GitHub. Cada publicación es un commit, así que todo queda en el historial de GitHub y se puede deshacer desde ahí.

## Mensajes que pueden salir

- *El token no es válido o ha caducado*: crea otro (paso 2).
- *El token no tiene permiso…*: el token necesita **Contents: Read and write** sobre ese repositorio.
- *No se encuentra el repositorio o la rama*: revisa `owner`, `repo` y `branch` en `config.js`.
- *No encuentro releases.json…*: revisa `root` en `config.js`.
- *SoundCloud no encuentra ese enlace*: el mixtape tiene que ser público en SoundCloud.

---

## Notas para la IA que lo revise

- Todo está ya preparado; solo hay que hacer commit y push. Si la copia local está atrasada respecto a GitHub, haz `git pull` antes y conserva estos cambios.
- `catalogue.html`: pestañas Releases / Radio (`#radio` abre Radio), lee también `mixtapes.json`.
- `index.html`:
  - La portada (`#home`) tiene `#hero-release` (texto + reproductor `.hc-player`) y `.hero-stage` con `#hero-cover` y la tarjeta `#hero-radio`.
  - La sección `#radio` lee `mixtapes.json`.
  - Funciones: `populateHero`, `populateRadioHero`, `bindPlayer` (un reproductor por bloque; solo suena uno a la vez), `loadRadio` (8 últimos), `fitHeroTitle`, `fillWave`, `analyseWave` (forma real del audio) y `liveWave` (barras con Web Audio mientras suena).
  - Sin `mixtapes.json`, la tarjeta de radio y la sección se ocultan y la web funciona igual.
- El panel usa la API de GitHub desde el navegador: `git/ref`, `git/commits`, `git/trees`, `git/blobs` y `PATCH git/refs` con `force: false`. Cada publicación es un único commit. Si otro commit entra a la vez, vuelve a leer y repite el cambio sin pisar el otro. Para Radio también lee el oEmbed público de SoundCloud y la portada de `*.sndcdn.com`.
- Formatos (indentación de 2 espacios; los campos que el panel no conoce se conservan):
  - `releases.json`: lista con lo más reciente primero. Campos: `id`, `catalog`, `artist`, `title`, `image` (archivo en `assets/`), `color` (#rrggbb) y, si existen, `stream_link`, `spotify_link`, `soundcloud_link` y `description`.
  - `mixtapes.json`: lista con lo más reciente primero. Campos: `id` (`mix011`), `number` (`#011`), `title`, `artist` (invitado), `image`, `color`, `preview` (MP3 corto en `assets/`, opcional) y `soundcloud_link`.
  - `playlists.json`: `title`, `link`, `image` y `description` (opcional).
- Si se sustituye un archivo, el nuevo lleva otro nombre para evitar la caché, y el antiguo se borra si ya no lo usa nadie.
- El panel no carga nada externo salvo las fuentes de Google (Bebas Neue y Barlow). Lleva su propia CSP y `noindex`.
- Scroll suave: `assets/vendor/lenis.min.js` (Lenis 1.3.26, licencia MIT en `LENIS-LICENSE.txt`), `assets/smooth-scroll.js` y `assets/smooth-scroll.css`, cargados en `index.html` y `catalogue.html`. Solo con ratón o trackpad; los paneles internos, el teclado y los saltos del menú siguen siendo nativos.
- Sincronización con SoundCloud: `.github/workflows/soundcloud-sync.yml` (cada 3 horas y a mano) ejecuta `scripts/sync-soundcloud.mjs`. Lee el feed RSS público `https://feeds.soundcloud.com/users/soundcloud:users:1309373238/sounds.rss` y solo añade lo que sea más nuevo que lo último ya publicado de cada tipo; si no encuentra nada conocido, no añade nada por seguridad, y nunca más de 6 por ejecución. Portadas a 1000×1000 con `sharp`; fragmentos con `ffmpeg` (busca la zona de más energía). Hace el commit como `github-actions[bot]` y pide a GitHub Pages que publique de nuevo. Requiere que Actions esté activado en el repositorio (lo está por defecto). GitHub pausa las tareas programadas si un repositorio pasa 60 días sin actividad; si pasa, se reactiva en Actions.
- Corte: `SINCE` en el script (28/01/2026, el día de «Kris m - Lights»). Las «Extended Mix» se descartan. Revisión sin cambiar nada: `SYNC_AUDIT=1 node scripts/sync-soundcloud.mjs` lista cada subida desde el corte y qué haría con ella.
- `sync-ignore.json` lo escribe el panel al eliminar (enlace de SoundCloud + título); el script trata esas entradas como ya publicadas.
- No toques `CNAME`.
