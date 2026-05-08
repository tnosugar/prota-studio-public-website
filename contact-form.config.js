// Prota Studios — contact-form Firebase config
//
// FIREBASE_CONFIG: paste the public client config from your new Firebase project
//   (Firebase Console → Project settings → Your apps → SDK setup → Config).
//   It is safe to commit this to the public repo; Firebase's security model is
//   enforced by Realtime Database rules, not by hiding the apiKey.
//
// PROJECT_REGION: should be us-central1 (or another US Firebase RTDB region) per
//   the user's directive on hosting region.
//
// CONTACTS_PATH: the RTDB node where contact submissions land. Each submission
//   is a push() child with an auto-generated ID (so submissions are never
//   overwritten, unlike a per-email upsert pattern).

window.PROTA_CONTACT_CONFIG = {
  FIREBASE_CONFIG: {
    apiKey: "REPLACE_WITH_REAL_API_KEY",
    authDomain: "prota-studios-contacts.firebaseapp.com",
    databaseURL: "https://prota-studios-contacts-default-rtdb.firebaseio.com",
    projectId: "prota-studios-contacts",
    storageBucket: "prota-studios-contacts.firebasestorage.app",
    messagingSenderId: "REPLACE_WITH_SENDER_ID",
    appId: "REPLACE_WITH_APP_ID",
  },
  CONTACTS_PATH: "contacts",
  ENABLED: false,  // flip to true once the real config is pasted in above
};
