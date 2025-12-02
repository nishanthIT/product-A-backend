const jwt = require('jsonwebtoken');

// This will decode the JWT token to see which customer is logged in
// You'll need to paste the token from your app's AsyncStorage

console.log("JWT Secret from .env:", process.env.JWT_SECRET);
console.log("\nTo check the logged-in customer:");
console.log("1. Get the token from your app");
console.log("2. Paste it here and decode it");
console.log("\nFor now, let's check the middleware behavior...");

// Let's modify the removeProductFromList to show the decoded customer ID
console.log("\nPlease check the backend logs when you try to delete.");
console.log("The logs should show: 'Customer ID from JWT: <number>'");
