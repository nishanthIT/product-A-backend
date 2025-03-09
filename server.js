// // import express from "express";
// // import dotenv from "dotenv";
// // import authRoutes from "./src/routes/authRoutes.js";
// // import cors from 'cors';
// // import cookieParser from 'cookie-parser';  // Add this import

// // dotenv.config();
// // const app = express();

// // // Configure CORS to allow all origins with credentials
// // app.use(cors({
// //   origin: (origin, callback) => {
// //     const allowedOrigins = ["http://localhost:8080", "http://192.168.126.1:8080"];
    
// //     if (!origin || allowedOrigins.includes(origin)) {
// //       callback(null, true);
// //     } else {
// //       callback(new Error("Not allowed by CORS"));
// //     }
// //   },
// //   credentials: true
// // }));

// // // Middleware
// // app.use(cookieParser());  // Add this middleware
// // app.use(express.json());

// // app.use("/api", authRoutes);

// // const PORT = process.env.PORT || 3000;
// // app.listen(PORT, () => {
// //   console.log(`Server is running on http://localhost:${PORT}`);
// // });


// import express from "express";
// import dotenv from "dotenv";
// import authRoutes from "./src/routes/authRoutes.js";
// import cors from 'cors';
// import cookieParser from 'cookie-parser';

// dotenv.config();
// const app = express();

// // Configure CORS with more precise settings
// app.use(cors({
//   origin: ["http://localhost:8080", "http://192.168.126.1:8080", "http://localhost:5173"], // Add your Vite dev server port (default 5173)
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization']
// }));

// // Middleware
// app.use(cookieParser());
// app.use(express.json());

// // Make auth route available
// app.use("/api", authRoutes);

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server is running on http://localhost:${PORT}`);
// });

import express from "express";
import dotenv from "dotenv";
import authRoutes from "./src/routes/authRoutes.js";
import cors from 'cors';
import cookieParser from 'cookie-parser';

dotenv.config();
const app = express();

// More permissive CORS setup
app.use(cors({
  origin: true, // Allow any origin for development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add extra header for cookies
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

app.use(cookieParser());
app.use(express.json());

app.use("/api", authRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});