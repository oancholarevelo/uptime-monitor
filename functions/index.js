const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const axios = require("axios");
const tls = require('tls');

admin.initializeApp();
const db = admin.firestore();

/**
 * NEW: Triggered function that performs an initial check when a new monitor is created.
 */
exports.onMonitorCreated = functions.firestore
    .document("monitors/{monitorId}")
    .onCreate(async (snap, context) => {
        const monitorId = context.params.monitorId;
        const monitorData = snap.data();
        console.log(`New monitor created: ${monitorId}. Performing initial check for ${monitorData.url}.`);
        return checkAndUpdateStatus(monitorId, monitorData);
    });

/**
 * Scheduled function that runs every 5 minutes to check all websites.
 */
exports.checkWebsites = functions
    .runWith({timeoutSeconds: 300})
    .pubsub.schedule("every 5 minutes")
    .onRun(async (context) => {
        console.log("Starting scheduled website status check for all monitors.");
        const monitorsSnapshot = await db.collection("monitors").get();

        if (monitorsSnapshot.empty) {
            console.log("No websites to monitor.");
            return null;
        }

        const promises = monitorsSnapshot.docs.map((doc) => {
            return checkAndUpdateStatus(doc.id, doc.data());
        });

        await Promise.all(promises);
        console.log("Finished scheduled website status check.");
        return null;
    });

/**
 * Helper function to get SSL certificate expiry date.
 * @param {string} hostname The hostname to check.
 * @return {Promise<object|null>} A promise that resolves with SSL info or null.
 */
const getSslExpiry = (hostname) => {
    return new Promise((resolve) => {
        try {
            const options = {
                host: hostname,
                port: 443,
                rejectUnauthorized: false // Important to get cert even if self-signed
            };

            const socket = tls.connect(options, () => {
                const cert = socket.getPeerCertificate();
                socket.end();

                if (cert && cert.valid_to) {
                    const expiryDate = new Date(cert.valid_to);
                    const daysRemaining = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
                    resolve({
                        expires: expiryDate.toISOString(),
                        daysRemaining: daysRemaining
                    });
                } else {
                    resolve(null);
                }
            });

            socket.on('error', (err) => {
                console.error(`SSL check error for ${hostname}:`, err.message);
                resolve(null);
            });
            
            socket.setTimeout(5000, () => {
                socket.destroy();
                console.error(`SSL check timed out for ${hostname}`);
                resolve(null);
            });

        } catch (error) {
            console.error(`Exception during SSL check for ${hostname}:`, error.message);
            resolve(null);
        }
    });
};


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
    let sslInfo = null;

    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol === 'https:') {
            sslInfo = await getSslExpiry(parsedUrl.hostname);
        }

        const response = await axios.get(url, {timeout: 10000});
        responseTime = Date.now() - startTime;

        if (response.status >= 200 && response.status < 300) {
            status = "UP";

            if (keyword) {
                const pageContent = response.data.toString().toLowerCase();
                if (!pageContent.includes(keyword.toLowerCase())) {
                    status = "DOWN";
                    console.log(`Site ${url} is UP (2xx) but keyword "${keyword}" was NOT found.`);
                }
            }
        } else {
            status = "DOWN";
        }
    } catch (error) {
        responseTime = Date.now() - startTime;
        console.error(`Error checking ${url}:`, error.message);
        status = "DOWN";
    }

    const updateData = {
        status: status,
        lastChecked: admin.firestore.FieldValue.serverTimestamp(),
        lastResponseTime: responseTime,
        sslExpires: sslInfo ? sslInfo.expires : null,
        sslDaysRemaining: sslInfo ? sslInfo.daysRemaining : null,
    };

    await monitorRef.update(updateData);

    return logRef.add({
        status: status,
        responseTime: responseTime,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
};


/**
 * Triggered function that sends an email alert when a site goes from UP to DOWN.
 */
exports.sendAlertOnStatusChange = functions.firestore
    .document("monitors/{monitorId}")
    .onUpdate(async (change) => {
        const before = change.before.data();
        const after = change.after.data();

        if (before.status === "UP" && after.status === "DOWN") {
            const {url, userId} = after;
            const user = await admin.auth().getUser(userId);
            const userEmail = user.email;

            if (!userEmail) {
                console.log(`User ${userId} has no email, alert not sent.`);
                return;
            }

            console.log(`Site ${url} went down. Triggering alert to ${userEmail}.`);

            await db.collection("mail").add({
                to: [userEmail],
                message: {
                    subject: `❗ Uptime Alert: ${url} is DOWN!`,
                    html: `<p>Hello,</p><p>Alert: <strong>${url}</strong> is down.</p><p>Detected at ${new Date().toUTCString()}.</p><p>Please check your website.</p><br/><p>Thank you,</p><p><strong>Your Uptime Monitor</strong></p>`,
                },
            });
        }
    });

/**
 * Recursively delete a collection and its subcollections.
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
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

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
        await deleteCollection(logsPath, 50);
        console.log(`Successfully deleted subcollections for monitor ${monitorId}`);
    });
