// This is a Vercel Serverless Function
// It will live at the path: /api/add-monitor.js

// The 'export default' is the standard way to define the function
export default function handler(request, response) {
  // We only want to handle POST requests for this endpoint
  if (request.method !== 'POST') {
    // If it's not a POST, send a 405 Method Not Allowed error
    return response.status(405).json({ message: 'Only POST requests are allowed' });
  }

  try {
    // Get the URL and email from the request body sent by the front-end
    const { url, email } = request.body;

    // --- Basic Validation ---
    if (!url || !email) {
      return response.status(400).json({ message: 'URL and Email are required.' });
    }

    // A simple check to see if the email format looks valid
    if (!/^\S+@\S+\.\S+$/.test(email)) {
        return response.status(400).json({ message: 'Please provide a valid email address.' });
    }

    // --- Placeholder for Future Logic ---
    // In the future, this is where we will:
    // 1. Save the { url, email } pair to a Firebase Firestore database.
    // 2. Send a confirmation email using a service like Resend or SendGrid.
    // 3. Set up the scheduled job to check the website.

    console.log(`Received monitor request for URL: ${url}, Email: ${email}`);

    // --- Send a Success Response ---
    // We send a 200 OK status with a success message.
    // The front-end will receive this JSON and display the success message.
    return response.status(200).json({ 
        message: `Successfully registered ${url} for monitoring. A confirmation will be sent to ${email}.` 
    });

  } catch (error) {
    // If any other error occurs, log it on the server and send a generic error message
    console.error(error);
    return response.status(500).json({ message: 'An internal server error occurred.' });
  }
}
