import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import config from 'config/env';

// Service-account credentials are read from a path configured via
// FIREBASE_SERVICE_ACCOUNT_PATH — never commit the JSON key file.
const loadServiceAccount = (): admin.ServiceAccount => {
  if (!config.FIREBASE_SERVICE_ACCOUNT_PATH) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH is required to use Firebase');
  }
  const file = path.resolve(process.cwd(), config.FIREBASE_SERVICE_ACCOUNT_PATH);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as admin.ServiceAccount;
};

// Initialize Firebase Admin only if it hasn't been initialized
function initializeFirebase(): admin.app.App {
  try {
    return admin.app();
  } catch {
    return admin.initializeApp({
      credential: admin.credential.cert(loadServiceAccount())
    });
  }
}

const firebaseApp = initializeFirebase();

export { admin, firebaseApp };
