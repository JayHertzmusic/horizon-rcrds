// Los 6 formularios que había en Google Forms (cuenta de Horizon), pasados a la web.
// Uso: node worker/forms-seed.mjs > forms.sql  y luego  wrangler d1 execute horizon-web --file=forms.sql (--local o --remote)
// Solo crea los que no existan (por enlace): no pisa cambios hechos en el panel.
const F = (title, slug, description, items) => ({ title, slug, description, items });
const t = (label, help = '', required = true) => ({ type: 'text', label, help, required });
const ta = (label, help = '', required = true) => ({ type: 'textarea', label, help, required });
const em = (label, help = '') => ({ type: 'email', label, help, required: true });
const rd = (label, options, help = '', other = false) => ({ type: 'radio', label, help, required: true, options, other });
const sec = (label, help = '') => ({ type: 'section', label, help });

const releaseIntro = 'Welcome to the HORIZON RCRDS team.\nWe’re thrilled to help bring your music to life. This form is the first step toward releasing your track with us. Keep it clear, honest, and feel free to be yourself, we’ll take care of the rest.\nIf you’re unsure about anything, just email us at: contacthorizonids@gmail.com';
const releaseItems = cover => [
  t('ARTIST NAME(s)', 'Stage name(s), in release order, commas if more than one.'),
  t('LEGAL FULL NAME(s)', 'We need this for contracts. Only used internally.'),
  em('CONTACT EMAIL', 'Main point of contact for this release.'),
  t('COUNTRY RESIDENCE', "Just the country you're currently based in."),
  sec('🎵 ABOUT THE TRACK', 'Provide us all the information about your track.'),
  t('TRACK TITLE', 'How should the song be listed on platforms. (Only the title)'),
  t('GENRE, MOOD & BPM', 'Tell us the style and the vibe of your track.'),
  ta("WHAT'S THE STORY BEHIND THE TRACK?", "Short or long, we're all ears.", false),
  t('LINK TO THE TRACK FILE', 'Attach all the track versions of it in WAV format. (Original Mix and Extended Mix). We recommend using Dropbox or Google Drive.'),
  sec('🎙️ VOCALS, CREDITS, ROYALTIES, AND ASSETS 💰'),
  rd('ARE THERE VOCALS IN THE TRACK?', ['Yes, sampled or royalty-free vocals.', 'Yes, original vocals.', 'No, there are no vocals.']),
  ta('DOES YOUR SONG HAVE LYRICS?', 'Write your song lyrics here.', false),
  t('OTHER COLLABORATORS TO CREDIT (PRODUCERS, WRITERS, ETC...)', '', false),
  rd('ROYALTIES & RIGHTS', ['100% to solo artist.', '50/50 between Artist A & B.'], 'How should royalties be divided?', true),
  ta('LINK TO YOUR PRESS PHOTO.', 'High-quality photo(s) for promo use.'),
  ...(cover ? [ta('SPECIFIC COVER ART IDEAS TO USE AS A REFERENCE.', 'At least two reference images and a specific color.')] : []),
  ta('WHAT KIND OF PROMOTION DO YOU HAVE PLANNED FOR THE TRACK?', 'For example: creating promotional content, exclusive content, newsletters, ads, etc.'),
  ...(cover ? [ta('DO YOU HAVE ANY OTHER UPCOMING RELEASES OR PROJECTS?', 'Tell us what’s coming.', false)] : []),
  sec('📲 SOCIAL MEDIA & PROMO'),
  t('SPOTIFY ARTIST PROFILE LINK', 'Copy-paste the URL – not just the name.'),
  t('APPLE MUSIC ARTIST PROFILE LINK', 'Copy-paste the URL – not just the name.'),
  t('BEATPORT ARTIST PROFILE LINK', 'Copy-paste the URL – not just the name.', false),
  ta('ANY OTHER SOCIALS', 'Instagram / SoundCloud / YouTube / TikTok etc...'),
  sec('✅ FINAL STEP'),
  rd('REVIEW ALL THE INFORMATION ON THE FORM AGAIN AND VERIFY THAT EVERYTHING IS CORRECT. IF SO, JUST FINISH.', ['Finish']),
];

const FORMS = [
  F('DUO DOMINATION', 'duo-domination', 'HRZ EVENT | DUO DOMINATION', [t('Team & Artist Names'), t('SoundCloud Private Link')]),
  F('DEMOS FOR HORIZON x STARIZED', 'starized-demos',
    'HORIZON RCRDS and STARIZED RECORDS are joining forces for a collaborative project focused on Future Bounce.\n\nWe’re looking for music with strong energy, clear identity, impactful drops, and a defined direction within the genre.\n\nThis is a selective process, and every demo is reviewed carefully.\n\nIf your track aligns with the vision of both labels, we’ll get in touch.',
    [t('ARTIST NAME'), t('TRACK NAME'), em('CONTACT EMAIL'), ta('PRIVATE LINK', 'Please provide a working link (preferably to SoundCloud or Dropbox)')]),
  F('Demo Submission', 'demo-submission', '',
    [t('Artist Name'), t('Track Name'), em('Contact Email'), t('Private Link (SoundCloud, Google Drive, Dropbox...)'), ta('Additional Information', '', false)]),
  F('HORIZON x STARIZED', 'hrz-x-strz', releaseIntro.replace('Welcome to the HORIZON RCRDS team.\n', ''), releaseItems(false)),
  F('Release Form', 'release-form', releaseIntro, releaseItems(true)),
  F('Send your ID', 'send-your-id', '',
    [t('Artist Name'), t('Private link (Soundcloud, Google Drive, Dropbox...)'),
     rd('How would you like your track to be featured when we publish it?', ['ID - ID', '(Artist Name) - ID', 'ID - ID (Name Track)']),
     rd('Would you like us to consider releasing your track through our label?', ['Yes', 'No']), em('Contact Email')]),
];

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const out = [
  `CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT, fields TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, on_site INTEGER NOT NULL DEFAULT 0, button TEXT, access TEXT NOT NULL DEFAULT '{}', created_at INTEGER, updated_at INTEGER);`,
  `CREATE TABLE IF NOT EXISTS form_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, form_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, ip TEXT);`,
];
const ts = Date.now();
FORMS.forEach((f, i) => {
  const fields = f.items.map((x, k) => ({ id: `q${k + 1}`, ...x }));
  out.push(`INSERT OR IGNORE INTO forms (id, slug, title, description, fields, position, public, on_site, button, access, created_at, updated_at) VALUES (${q('f_' + f.slug.replace(/-/g, '').slice(0, 12))}, ${q(f.slug)}, ${q(f.title)}, ${q(f.description)}, ${q(JSON.stringify(fields))}, ${i + 1}, 0, 0, '', '{}', ${ts}, ${ts});`);
});
process.stdout.write(out.join('\n') + '\n');
