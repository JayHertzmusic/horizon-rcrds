# Panel de HORIZON RCRDS

Un panel para publicar en la web sin tocar código: **releases**, **playlists**, **audio del reproductor** y **logo / icono**.

No necesita servidor ni cuentas nuevas. El panel se instala como una carpeta `admin/` dentro de la web y guarda cada cambio directamente en el repositorio de GitHub. GitHub Pages vuelve a publicar la web sola en 1–2 minutos.

La web no cambia: sigue leyendo `releases.json`, `playlists.json` y `assets/` como hasta ahora.

---

## 1. Publicar el panel (una sola vez)

El panel ya está instalado y configurado en esta carpeta, en `admin/`, con `config.js` apuntando a `JayHertzmusic/horizon-rcrds` (rama `main`). No hay que tocar nada más.

- **Si esta carpeta es tu copia de la web:** haz commit de la carpeta `admin/` y push. Si GitHub dice que tu copia está atrasada, haz antes `git pull`.
- **Si tienes otra copia más reciente de la web:** copia solo la carpeta `admin/` en tu copia, junto a `index.html`, y haz commit y push.

Después el panel queda en **https://horizonrcrds.com/admin/**.

## 2. Crear el token de GitHub (una vez por navegador o cuando caduque)

1. GitHub → *Settings* → *Developer settings* → *Personal access tokens* → **Fine-grained tokens** → *Generate new token*.
2. **Repository access**: *Only select repositories* → solo el repositorio de la web.
3. **Permissions → Repository permissions → Contents: Read and write**. No hace falta ningún otro permiso.
4. Elige la caducidad, pulsa *Generate token* y pega el token en el panel.

El token se guarda solo en ese navegador. **Salir** lo borra. Nunca lo subas al repositorio ni lo pongas en `config.js`.

## 3. Usarlo

- **Releases**: **+ Nuevo lanzamiento** → arrastra la portada → rellena título, artistas y enlaces → **Publicar**.
  - La portada sale cuadrada a 1000×1000 en JPG, como las actuales, aunque la subas de otro tamaño.
  - El color se saca solo de la portada y se puede cambiar.
  - El nº de catálogo se propone solo (el siguiente HRZ#).
  - La posición 1 es el lanzamiento de la portada de la web.
  - **Editar** sirve para cambiar cualquier cosa, moverlo de posición o eliminarlo. Al eliminar un lanzamiento también se borra su portada.
- **Playlists**: igual que los releases (portada, título, descripción, enlace y posición).
- **Reproductor**: sustituye `assets/release_preview.mp3`, el audio del reproductor de la portada.
- **Logo**: sustituye `assets/logo.png` y `assets/favicon_icon.png`. Tienen que ser PNG.

Tras **Publicar**, el panel avisa con «✓ Ya está en la web» cuando la web ya muestra el cambio. Si alguien ya tenía la web abierta, puede tardar hasta 10 minutos en ver el cambio por la caché de GitHub. Cada publicación es un commit, así que todo queda en el historial de GitHub y se puede deshacer desde ahí.

## Mensajes que pueden salir

- *El token no es válido o ha caducado*: crea otro (paso 2).
- *El token no tiene permiso…*: el token necesita **Contents: Read and write** sobre ese repositorio.
- *No se encuentra el repositorio o la rama*: revisa `owner`, `repo` y `branch` en `config.js`.
- *No encuentro releases.json…*: revisa `root` en `config.js`.

---

## Notas para la IA que lo instale

- La carpeta `admin/` (index.html, admin.js, admin.css, config.js) ya está lista y `config.js` ya está rellenado. Solo hay que subirla al repositorio. **No modifiques `index.html` ni `catalogue.html` de la web, ni el formato de los JSON.**
- El panel usa la API de GitHub desde el navegador: `git/ref`, `git/commits`, `git/trees`, `git/blobs` y `PATCH git/refs` con `force: false`. Cada publicación es un único commit. Si otro commit entra a la vez, vuelve a leer y repite el cambio sin pisar el otro.
- Formato que escribe:
  - `releases.json`: lista con lo más reciente primero. Cada lanzamiento lleva `id`, `catalog`, `artist`, `title`, `image` (nombre de archivo dentro de `assets/`), `color` (#rrggbb) y, solo si existen, `stream_link`, `spotify_link`, `soundcloud_link` y `description`. Los campos que no conoce se conservan tal cual.
  - `playlists.json`: `title`, `link`, `image` y `description` (opcional).
  - Indentación de 2 espacios.
- Las portadas nuevas se llaman `<id>.jpg`. Si se sustituye una portada, el archivo nuevo lleva otro nombre para evitar la caché, y el antiguo se borra si ya no lo usa nadie.
- El panel no carga nada externo salvo las fuentes de Google (Bebas Neue y Barlow, las mismas de la web). Lleva su propia CSP y `noindex`.
- Si la web tiene `CNAME`, no lo toques.
