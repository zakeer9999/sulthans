/* Sulthan's — deployment config.
   Leave the values empty and the app runs exactly as it does today: menu, orders,
   ratings and feedback all live in the browser it was opened in. Fill them in and
   the same app talks to Supabase and streams dish video from Cloudflare R2, with
   no other code change. See SETUP.md. */
window.SULTHANS_CONFIG = {
  /* Where this restaurant is. Used for the assistant's name, local trends and
     the weather forecast. lat/lon: right-click the spot in Google Maps. */
  restaurantName: "Sulthan's",
  town: 'Aruppukottai, Virudhunagar district, Tamil Nadu',
  lat: 9.51,
  lon: 78.10,
  /* Sending a WhatsApp push without a cashier tapping through it needs a
     WhatsApp Cloud API token, and a token in the till's browser is a token on
     the internet. So it lives in an endpoint you deploy — a Supabase Edge
     Function is the short way — and this is its URL. The counter POSTs
     {to, text, campaign} per recipient and marks the ledger from the reply.
     Left empty, the push panel hands each message to WhatsApp on the device
     instead, which needs no token and no server. */
  waSendUrl: '',

  // ---- Supabase (Project settings -> API) --------------------------------
  supabaseUrl: 'https://zcxasekfikdlbgohxivq.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjeGFzZWtmaWtkbGJnb2h4aXZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0NjA5NjUsImV4cCI6MjEwMjAzNjk2NX0.lNYBjsDhzGIe_8-KbFTPdelum4RFZ2x5yYgh4skWgwU',
  restaurantSlug: 'sulthans',

  // ---- Cloudflare R2 ----------------------------------------------------
  // Public base URL of the bucket: a custom domain (media.yourdomain.com) or the
  // r2.dev subdomain while testing.
  mediaBase: 'https://pub-68df159019bb40c1bc1db40b4298cdb3.r2.dev',

  // Poster file extension, whichever your phone exports. Keep every poster the
  // same — 'jpeg' and 'jpg' are different filenames to R2.
  posterExt: 'jpeg',

  // Default video container for dish folders. 'mp4' plays everywhere; 'mov'
  // only if the clip inside is H.264 (iPhone: Settings → Camera → Formats →
  // Most Compatible). A .mov holding HEVC plays on iPhones and shows black on
  // Android, so mp4 stays the default.
  videoExt: 'mp4',

  // Dish ids that have a video in R2. For each id listed here the app loads
  //   <mediaBase>/<id>/video.<videoExt>   and   <mediaBase>/<id>/poster.<posterExt>
  // so uploading a dish is two files in a folder named after its id, plus one
  // line here. Ids are in media/DISH-IDS.md. Unlisted dishes keep their
  // typographic card, which is the intended look — not a missing video.
  // A single dish can override the container by appending it: 'shakes-4.mov'.
  // '*' = the whole menu is uploaded; the app expands it to every dish id. To go
  // back to a partial rollout, replace it with the ids that are really in the
  // bucket. A single dish can still override the container: 'shakes-4.mov'.
  dishVideos: ['*'],

  // Hero video. One render for every screen, with a keyframe every few frames so
  // scrubbing seeks cheaply — that density, not the file size, is what fixes the
  // stutter on mid-range Android.
  //
  // 720 only, deliberately. The 1080 was 56MB against the 720's 22MB, and on a
  // tablet the hero is full-bleed and always in motion, where upscaling reads as
  // soft rather than broken. Paying 2.5x the bytes on every first load to sharpen
  // a minority of screens is the wrong trade. To add a tablet render later, set
  // `tablet` and a `wideAt` width — but only once the file is really in the
  // bucket; a fallback pointing at a missing render fails harder than no
  // fallback at all.
  heroVideo: {
    dir: 'hero',
    phone: 'hero-720.mp4',
    poster: 'hero-poster.jpeg',
    // Still hero. Three taps on the logo while the hero downloads swap the scrub
    // for this photograph, with the same four lines paced by scroll. Upload it
    // beside the video as hero/hero-still.jpeg.
    still: 'hero-still.jpeg',
    // Sizes are only for the loading bar; leave one out and the bar reads the
    // server's content-length instead of a stale number.
    bytes: {},
  },

  // Hero frame sequence. The opening scroll pages through stills in
  //   <mediaBase>/hero-frames/f0000.<ext> ... f<count-1>.<ext>
  // instead of seeking the video, which is the only way the scrub runs smoothly
  // on mid-range Android. Generate the folder with the Hero Frames tool, upload
  // it, then set the count it reports — or extract them with ffmpeg on a PC, per
  // media/FFMPEG-HERO.md. Leave count at 0 and the hero keeps scrubbing
  // hero.mp4 as before.
  // Tried and rejected: the sequence scrubbed worse than the video on the test
  // phones, not better, and the folder is gone from R2. Left at 0 deliberately.
  heroFrames: { count: 0, ext: 'webp' },

  // UPI id money is collected on, e.g. 'sulthans@okhdfcbank'. Set this and the
  // payment sheet offers "Pay in your UPI app" on phones — it opens GPay/PhonePe/
  // Paytm with the amount and bill number already filled. Leave empty and the
  // sheet shows only the QR code, exactly as before.
  upiId: '',
  upiName: '',

  // Staff sign-in for the admin panel. Optional: when set, the admin gate signs
  // in to Supabase Auth so guest comments become readable under RLS.
  staffEmail: 'zakeerhussain9999@gmail.com',

  // ---- The assistant ----------------------------------------------------
  // Two ways to run it, and only one of these two lines should be filled in.
  //
  // agentBase: a running server (ai/ folder, `npm run dev`, or deployed). Best
  //   option — keys stay on the server and the outward-looking half works:
  //   Instagram, Facebook, Google reviews, competitors, the 9am brief.
  //   Example: 'http://localhost:3000/api' or 'https://sulthans-ai.vercel.app/api'
  //
  // groqKey: no server at all. The assistant talks to Groq straight from this
  //   page and reads Postgres through the staff session the admin password
  //   already opens. Works on a phone with nothing installed.
  //
  //   Understand the trade before filling it in: this key is readable by anyone
  //   who opens this file or views the page source. It is rate-limited and
  //   rotatable, and it buys an attacker nothing but free tokens — but treat it
  //   as public. Rotate it at console.groq.com/keys if the page is ever hosted
  //   somewhere you do not control. Never put the Supabase secret key here;
  //   Supabase refuses secret keys from a browser anyway.
  //
  //   In this mode the assistant reads this restaurant's own numbers only. No
  //   social, no reviews, no competitors — it says so when asked.
  agentBase: '',
  groqKey: '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',

  // geminiKey: the whole voice path, plus a third rung under chat. Gemini hears
  //   Tamil and Telugu and reports which was spoken, writes the reply back into
  //   that language, and reads it aloud — the browser's own voice has no Tamil
  //   or Telugu on most phones and mangles the script. It also finishes a
  //   question on Google's quota when Groq's free tier is spent for the day.
  //   Without it: Whisper hears (no language detection), Qwen translates, and
  //   the browser speaks — everything still works, worse.
  //
  //   Google issues these in two shapes: the older AIza… and the newer AQ.…
  //   (AI Studio lists both as "Gemini API Key"). Either works. Get one at
  //   aistudio.google.com/apikey. Same warning as above — this file is
  //   published, so treat the key as public and rotate it when that matters.
  geminiKey: 'AQ.Ab8RN6J4CE4onxoMZLz9vnVEGDfqX87ZzTgcKVJOn28Wm2x3wg',

  // Admin panel password, as a SHA-256 hex digest — the password itself is never
  // in any file the browser downloads. Leave empty to keep the built-in one.
  // To change it, run in any browser console:
  //   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YourNewPassword'))
  //     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
  // A hash keeps the password out of the source; it does not make the panel
  // tamper-proof on its own. See the Security section of SETUP.md.
  adminPasswordHash: 'cf4d2cbac4b30a7f3ad07a2f1a689af60f3df3e05b954c5a8a6b619d1f242d40',
};
