// /api/cron.js
// This is a Vercel Cron Job that runs on a schedule.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

// Initialize Firebase Admin SDK using environment variables
// This ensures we only initialize it once.
if (!initializeApp.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  initializeApp({
    credential: cert(serviceAccount)
  });
}

const db = getFirestore();

// The main handler for the cron job
export default async function handler(request, response) {
  try {
    // Get all the documents from the 'monitors' collection
    const monitorsRef = db.collection('monitors');
    const snapshot = await monitorsRef.get();

    if (snapshot.empty) {
      console.log('No monitors to check.');
      return response.status(200).send('No monitors to check.');
    }

    // Create an array of promises for all the check operations
    const checkPromises = snapshot.docs.map(async (doc) => {
      const monitor = doc.data();
      const { url, status: lastStatus } = monitor;
      let currentStatus = 'DOWN';

      try {
        // Fetch the website URL. We set a timeout of 10 seconds.
        const fetchResponse = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (fetchResponse.ok) {
          currentStatus = 'UP';
        }
      } catch (error) {
        // Any error (timeout, network error, etc.) means the site is down.
        console.warn(`Error checking ${url}:`, error.message);
        currentStatus = 'DOWN';
      }

      // Update the document in Firestore with the new status and lastChecked timestamp
      await doc.ref.update({
        status: currentStatus,
        lastChecked: Timestamp.now()
      });
      
      // --- EMAIL ALERT LOGIC ---
      // If the status has changed from UP to DOWN, send an email.
      if (lastStatus === 'UP' && currentStatus === 'DOWN') {
        // TODO: Add email sending logic here using a service like SendGrid or Resend.
        console.log(`EMAIL ALERT: ${url} is DOWN!`);
      }
    });

    // Wait for all the checks to complete
    await Promise.all(checkPromises);

    return response.status(200).send('Monitoring checks completed successfully.');

  } catch (error) {
    console.error('Error in cron job:', error);
    return response.status(500).send('Internal Server Error');
  }
}
