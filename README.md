# Lift Log

An offline workout tracker for your iPhone. No account and no server: everything is saved on your phone.

## Put it online for free (GitHub Pages)

1. Sign in at github.com (or make a free account).
2. Tap **+** (top right) → **New repository**. Name it `liftlog`, keep it **Public**, and tap **Create repository**.
3. On the new repo page, tap **uploading an existing file**.
4. Drag in everything inside this `liftlog` folder: `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, and the `icons` folder. Tap **Commit changes**.
5. Go to **Settings** → **Pages**. Under "Branch," pick **main** and **/ (root)**, then tap **Save**.
6. Wait a minute or two, then refresh that page. Your address shows at the top, like `https://YOUR-NAME.github.io/liftlog/`.

Only the app's code is public. Your workouts never leave your phone.

**Another option, Netlify Drop:** sign in at app.netlify.com/drop and drag the whole `liftlog` folder onto the page. It gives you an address right away.

## Install it on your iPhone

1. Open your address in **Safari**.
2. Tap the **Share** button (the square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open Lift Log from the new Home Screen icon. Do it once while you have signal so it saves itself for offline use.
4. To test, turn on Airplane Mode and open it again. It should work the same.

## Good to know

- **Always use the Home Screen icon.** On iPhone, the icon and a Safari tab keep separate data.
- **Back up now and then:** More → Export backup, then save the file to iCloud Drive or Files. Deleting the icon deletes its data.
- **Rest timer alerts:** iPhone doesn't let web apps vibrate, so the timer beeps and flashes green. Keep the app open on screen and your ringer on.
- **Updates:** after a new version is uploaded, the app picks it up on the second launch. When you change the code, change `liftlog-v1` in `sw.js` to a new number.
