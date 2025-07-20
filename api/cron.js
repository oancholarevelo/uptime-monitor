// /api/cron.js
// This version includes more detailed logging to help debug server crashes.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// --- Firebase Admin SDK Initialization ---
// This block is wrapped in a try-catch to provide a clear error if credentials are the issue.
try {
  if (!getApps().length) {
    console.log('Initializing Firebase Admin SDK...');
    const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!serviceAccountString) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    }
    const serviceAccount = JSON.parse(serviceAccountString);
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log('Firebase Admin SDK Initialized Successfully.');
  }
} catch (e) {
  console.error('CRITICAL: Firebase Admin SDK initialization failed.', e);
  // We need to return a response here to stop the function execution
  // This helps prevent further crashes.
  // Note: This won't be sent to the browser, but it's good practice.
  // The actual error will be in the Vercel logs.
  // We can't do anything else if the SDK fails to load.
}

const db = getFirestore();

// The main handler for the cron job
export default async function handler(request, response) {
  console.log('Cron job handler started.');
  try {
    const monitorsRef = db.collection('monitors');
    const snapshot = await monitorsRef.get();

    if (snapshot.empty) {
      console.log('No monitors found to check.');
      return response.status(200).send('No monitors to check.');
    }

    console.log(`Found ${snapshot.docs.length} monitors to check.`);

    const checkPromises = snapshot.docs.map(async (doc) => {
      const monitor = doc.data();
      const { url, status: lastStatus } = monitor;
      let currentStatus = 'DOWN';

      try {
        const fetchResponse = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (fetchResponse.ok) {
          currentStatus = 'UP';
        }
      } catch (error) {
        console.warn(`Check failed for ${url}:`, error.message);
        currentStatus = 'DOWN';
      }

      await doc.ref.update({
        status: currentStatus,
        lastChecked: Timestamp.now()
      });
      
      if (lastStatus === 'UP' && currentStatus === 'DOWN') {
        console.log(`ALERT: ${url} is now DOWN.`);
        // TODO: Add email sending logic here.
      }
    });

    await Promise.all(checkPromises);

    console.log('Cron job handler finished successfully.');
    return response.status(200).send('Monitoring checks completed successfully.');

  } catch (error) {
    console.error('FATAL: Error within cron job handler:', error);
    return response.status(500).send('Internal Server Error');
  }
}
