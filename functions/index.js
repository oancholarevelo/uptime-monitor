const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

/**
 * Scheduled function that runs every 5 minutes to check all websites.
 */
exports.checkWebsites = functions
    .runWith({timeoutSeconds: 300})
    .pubsub.schedule("every 5 minutes")
    .onRun(async (context) => {
        console.log("Starting website status check for all monitors.");
        const monitorsSnapshot = await db.collection("monitors").get();

        if (monitorsSnapshot.empty) {
            console.log("No websites to monitor.");
            return null;
        }

        const promises = monitorsSnapshot.docs.map((doc) => {
            return checkAndUpdateStatus(doc.id, doc.data());
        });

        await Promise.all(promises);
        console.log("Finished website status check for all monitors.");
        return null;
    });

/**
 * Helper function to check a single URL, log history, and update its status.
 * @param {string} docId The Firestore document ID.
 * @param {object} monitor The monitor data object.
 */
const checkAndUpdateStatus = async (docId, monitor) => {
    const {url, keyword} = monitor;
    const monitorRef = db.collection("monitors").doc(docId);
    const logRef = monitorRef.collection("logs");

    let status = "DOWN";
    let responseTime = -1;
    const startTime = Date.now();

    try {
        const response = await axios.get(url, {timeout: 10000});
        responseTime = Date.now() - startTime;

        if (response.status >= 200 && response.status < 300) {
            status = "UP"; // Assume UP if status code is 2xx

            // If a keyword is specified, perform an additional check
            if (keyword) {
                const pageContent = response.data.toString().toLowerCase();
                if (!pageContent.includes(keyword.toLowerCase())) {
                    status = "DOWN"; // Mark as DOWN if keyword is missing
                    console.log(
                        `Site ${url} is UP (2xx) but keyword "${keyword}" was NOT found.`,
                    );
                }
            }
        } else {
            // Status code was not 2xx
            status = "DOWN";
        }
    } catch (error) {
        responseTime = Date.now() - startTime;
        console.error(`Error checking ${url}:`, error.message);
        status = "DOWN";
    }

    // 1. Update the main monitor document in Firestore
    await monitorRef.update({
        status: status,
        lastChecked: admin.firestore.FieldValue.serverTimestamp(),
        lastResponseTime: responseTime,
    });

    // 2. Create a new log entry in the 'logs' subcollection
    return logRef.add({
        status: status,
        responseTime: responseTime,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
};

/**
 * Triggered function that sends an email alert when a site goes from UP to DOWN.
 * Requires the "Trigger Email" Firebase Extension to be installed.
 */
exports.sendAlertOnStatusChange = functions.firestore
    .document("monitors/{monitorId}")
    .onUpdate(async (change) => {
        const before = change.before.data();
        const after = change.after.data();

        // Check if the status has changed from UP to DOWN
        if (before.status === "UP" && after.status === "DOWN") {
            const {url, userId} = after;

            // Get the user's details from Firebase Auth
            const user = await admin.auth().getUser(userId);
            const userEmail = user.email;

            if (!userEmail) {
                console.log(`User ${userId} has no email, alert not sent.`);
                return;
            }

            console.log(`Site ${url} went down. Triggering alert to ${userEmail}.`);

            // Create a document in the 'mail' collection to trigger the email ext
            await db.collection("mail").add({
                to: [userEmail],
                message: {
                    subject: `❗ Uptime Alert: ${url} is DOWN!`,
                    html: `
                        <p>Hello,</p>
                        <p>Alert: <strong>${url}</strong> is down.</p>
                        <p>Detected at ${new Date().toUTCString()}.</p>
                        <p>Please check your website.</p>
                        <br/>
                        <p>Thank you,</p>
                        <p><strong>Your Uptime Monitor</strong></p>
                    `,
                },
            });
        }
    });

/**
 * Recursively delete a collection and its subcollections.
 * @param {string} collectionPath The path to the collection to delete.
 * @param {number} batchSize The number of documents to delete in each batch.
 */
async function deleteCollection(collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(query, resolve) {
    const snapshot = await query.get();

    const batchSize = snapshot.size;
    if (batchSize === 0) {
        // When there are no documents left, we are done
        resolve();
        return;
    }

    // Delete documents in a batch
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    // Recurse on the next process tick, to avoid
    // exploding the stack.
    process.nextTick(() => {
        deleteQueryBatch(query, resolve);
    });
}


/**
 * Triggered function that deletes all logs in a monitor's subcollection
 * when the monitor document is deleted.
 */
exports.deleteMonitorSubcollections = functions.firestore
    .document("monitors/{monitorId}")
    .onDelete(async (snap, context) => {
        const monitorId = context.params.monitorId;
        console.log(`Deleting subcollections for monitor ${monitorId}`);

        const logsPath = `monitors/${monitorId}/logs`;
        await deleteCollection(logsPath, 50); // Adjust batch size as needed

        console.log(`Successfully deleted subcollections for monitor ${monitorId}`);
    });
    