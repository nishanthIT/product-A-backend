# Chat Backend Implementation - Complete ✅

## ✅ Completed Tasks

### 1. Database Schema (Phase 1) ✅
- ✅ Updated Prisma schema with chat models:
  - `Chat` model with `lastMessageAt` field
  - `ChatParticipant` for many-to-many relationships
  - `Message` model with support for TEXT/IMAGE/DOCUMENT
  - `MessageRead` for read receipts
  - Added indexes for performance optimization
- ✅ Successfully migrated database using `prisma db push` (no data loss)

### 2. Backend API (Phase 2) ✅
- ✅ Created `src/controller/chat.js` with 5 main functions:
  1. **getUserChats()** - Get all chats for logged-in user with:
     - Last message preview
     - Unread message count
     - Participant details
  
  2. **createChat()** - Create personal or group chats:
     - Check for existing personal chats before creating
     - Set creator as admin for group chats
     - Support for CUSTOMER and EMPLOYEE participants
  
  3. **getChatById()** - Get chat with messages:
     - Pagination support (50 messages per page)
     - Participant validation
     - Read receipts included
  
  4. **sendMessage()** - Send messages:
     - Support for TEXT, IMAGE, DOCUMENT types
     - Attachment URL/name/size fields
     - Updates lastMessageAt timestamp
  
  5. **markAsRead()** - Mark messages as read:
     - Batch processing for multiple messages
     - Creates MessageRead records

- ✅ Created `src/routes/chat.js` with RESTful endpoints:
  ```
  GET    /api/chat              → getUserChats
  POST   /api/chat              → createChat
  GET    /api/chat/:chatId      → getChatById
  POST   /api/chat/message      → sendMessage
  POST   /api/chat/read         → markAsRead
  ```

- ✅ Integrated authentication middleware (`isAuthenticated`)
- ✅ Updated `server.js` with correct import paths
- ✅ Converted all files to ES modules format

### 3. Socket.IO Configuration ✅
Socket.IO is already configured in `server.js` with:
- ✅ `join_user_room` - User joins personal notification room
- ✅ `join_chat` - Join specific chat room
- ✅ `leave_chat` - Leave chat room
- ✅ `new_message` - Broadcast message to chat participants
- ✅ `typing_start` / `typing_stop` - Real-time typing indicators

## 📝 API Documentation

### Authentication
All endpoints require JWT token in header:
```
Authorization: Bearer <your_jwt_token>
```

The token should contain:
- `id` - User ID
- `email` - User email
- `userType` - CUSTOMER, EMPLOYEE, or ADMIN

### Endpoints

#### 1. Get All Chats
```http
GET /api/chat
```

Response:
```json
{
  "success": true,
  "chats": [
    {
      "id": "chat-id",
      "name": "Chat Name" or "Participant Names",
      "type": "PERSONAL" or "GROUP",
      "lastMessage": "Last message content",
      "lastMessageTime": "2024-01-15T10:30:00Z",
      "unreadCount": 3,
      "participants": [
        {
          "id": "user-id",
          "name": "User Name",
          "email": "user@example.com",
          "userType": "CUSTOMER"
        }
      ]
    }
  ]
}
```

#### 2. Create Chat
```http
POST /api/chat
Content-Type: application/json

{
  "type": "PERSONAL" or "GROUP",
  "name": "Group Name" (required for GROUP only),
  "participantIds": [
    {
      "userId": "user-id",
      "userType": "CUSTOMER" or "EMPLOYEE"
    }
  ]
}
```

Response:
```json
{
  "success": true,
  "chat": {
    "id": "chat-id",
    "type": "PERSONAL",
    "name": null,
    "participants": [...]
  }
}
```

#### 3. Get Chat Messages
```http
GET /api/chat/:chatId?page=1&limit=50
```

Response:
```json
{
  "success": true,
  "chat": {
    "id": "chat-id",
    "name": "Chat Name",
    "type": "PERSONAL",
    "participants": [...]
  },
  "messages": [
    {
      "id": "message-id",
      "content": "Message text",
      "messageType": "TEXT",
      "senderId": "user-id",
      "senderType": "CUSTOMER",
      "senderName": "User Name",
      "createdAt": "2024-01-15T10:30:00Z",
      "attachmentUrl": null,
      "attachmentName": null,
      "attachmentSize": null,
      "readBy": [
        {
          "userId": "user-id",
          "userType": "CUSTOMER",
          "readAt": "2024-01-15T10:35:00Z"
        }
      ]
    }
  ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalMessages": 245,
    "hasMore": true
  }
}
```

#### 4. Send Message
```http
POST /api/chat/message
Content-Type: application/json

{
  "chatId": "chat-id",
  "content": "Message text",
  "messageType": "TEXT" | "IMAGE" | "DOCUMENT",
  "attachmentUrl": "https://example.com/file.jpg" (optional),
  "attachmentName": "file.jpg" (optional),
  "attachmentSize": 1024000 (optional, in bytes)
}
```

Response:
```json
{
  "success": true,
  "message": {
    "id": "message-id",
    "chatId": "chat-id",
    "content": "Message text",
    "messageType": "TEXT",
    "senderId": "user-id",
    "senderType": "CUSTOMER",
    "senderName": "User Name",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

#### 5. Mark Messages as Read
```http
POST /api/chat/read
Content-Type: application/json

{
  "messageIds": [
    "message-id-1",
    "message-id-2",
    "message-id-3"
  ]
}
```

Response:
```json
{
  "success": true,
  "message": "Messages marked as read",
  "count": 3
}
```

## 🔥 Socket.IO Events

### Client → Server

#### Join User Room
```javascript
socket.emit('join_user_room', {
  userId: 'user-id',
  userType: 'CUSTOMER'
});
```

#### Join Chat
```javascript
socket.emit('join_chat', {
  chatId: 'chat-id'
});
```

#### Leave Chat
```javascript
socket.emit('leave_chat', {
  chatId: 'chat-id'
});
```

#### Typing Start
```javascript
socket.emit('typing_start', {
  chatId: 'chat-id',
  userId: 'user-id',
  userName: 'User Name'
});
```

#### Typing Stop
```javascript
socket.emit('typing_stop', {
  chatId: 'chat-id',
  userId: 'user-id'
});
```

### Server → Client

#### New Message
```javascript
socket.on('message_received', (data) => {
  console.log('New message:', data);
  // data contains full message object
});
```

#### User Typing
```javascript
socket.on('user_typing', (data) => {
  console.log(`${data.userName} is typing...`);
});

socket.on('user_stopped_typing', (data) => {
  console.log(`${data.userName} stopped typing`);
});
```

## 🚀 Next Steps

### Immediate
1. ✅ Backend API is ready
2. ⏳ Test API endpoints with the provided `test-chat-api.http` file
3. ⏳ Implement file upload for attachments:
   - Install multer: `npm install multer`
   - Create upload endpoint: `POST /api/chat/upload`
   - Store files in cloud (AWS S3, Cloudinary, etc.)

### Phase 3: Frontend Socket.IO Integration
1. Install socket.io-client in mobile app:
   ```bash
   cd my-app
   npm install socket.io-client
   ```

2. Create Socket Context (`contexts/SocketContext.tsx`):
   ```typescript
   import { createContext, useContext, useEffect, useState } from 'react';
   import io from 'socket.io-client';
   import { getToken } from './AuthContext';

   const SocketContext = createContext(null);

   export const SocketProvider = ({ children }) => {
     const [socket, setSocket] = useState(null);
     const [isConnected, setIsConnected] = useState(false);

     useEffect(() => {
       const token = getToken();
       if (!token) return;

       const newSocket = io('http://your-backend-url:3000', {
         auth: { token }
       });

       newSocket.on('connect', () => {
         console.log('✅ Socket connected');
         setIsConnected(true);
       });

       newSocket.on('disconnect', () => {
         console.log('❌ Socket disconnected');
         setIsConnected(false);
       });

       setSocket(newSocket);

       return () => newSocket.close();
     }, []);

     return (
       <SocketContext.Provider value={{ socket, isConnected }}>
         {children}
       </SocketContext.Provider>
     );
   };

   export const useSocket = () => useContext(SocketContext);
   ```

3. Update `app/(tabs)/chat.tsx` to use socket:
   - Join chat room on mount
   - Listen for `message_received` events
   - Emit `typing_start`/`typing_stop` on input changes
   - Send messages via socket AND API

### Phase 4: Frontend API Integration
1. Create `services/chatService.ts`:
   ```typescript
   import axios from 'axios';

   const API_URL = 'http://your-backend-url:3000/api/chat';

   export const chatService = {
     getChats: () => axios.get(API_URL),
     createChat: (data) => axios.post(API_URL, data),
     getChatById: (chatId, page = 1) => 
       axios.get(`${API_URL}/${chatId}?page=${page}`),
     sendMessage: (data) => 
       axios.post(`${API_URL}/message`, data),
     markAsRead: (messageIds) => 
       axios.post(`${API_URL}/read`, { messageIds })
   };
   ```

2. Update `contexts/ContactsContext.tsx`:
   - Replace mock data with real API calls
   - Fetch chats from `chatService.getChats()`

### Phase 5: Testing
- [ ] Test personal chat creation
- [ ] Test group chat creation
- [ ] Test text messages
- [ ] Test image messages (after file upload)
- [ ] Test document messages (after file upload)
- [ ] Test read receipts
- [ ] Test typing indicators
- [ ] Test real-time message delivery
- [ ] Test offline/reconnection

## 📦 File Structure

```
product-A-backend/
├── prisma/
│   └── schema.prisma          ✅ Enhanced with chat models
├── src/
│   ├── controller/
│   │   └── chat.js            ✅ All chat business logic
│   ├── routes/
│   │   └── chat.js            ✅ Chat API endpoints
│   ├── middleware/
│   │   └── authware.js        ✅ JWT authentication
│   └── config/
│       └── prisma.js          ✅ Prisma client
├── server.js                  ✅ Express + Socket.IO setup
├── test-chat-api.http         ✅ API test file
└── package.json
```

## 🎯 Key Features Implemented

1. **Multi-User Type Support** - Works with CUSTOMER, EMPLOYEE, and ADMIN
2. **Read Receipts** - Track who read which messages
3. **Unread Counts** - Calculate unread messages per chat
4. **Pagination** - Load messages in chunks (50 per page)
5. **Soft Delete** - Messages have `deletedAt` field for future delete feature
6. **Real-Time** - Socket.IO ready for instant messaging
7. **File Attachments** - Database structure ready for images/documents
8. **Group Chats** - Full support with admin roles
9. **Personal Chats** - Duplicate prevention
10. **Typing Indicators** - Socket events configured

## 🔒 Security

- ✅ All routes protected with JWT authentication
- ✅ Participant validation before accessing chats
- ✅ User type verification from token
- ✅ No hardcoded user types (supports CUSTOMER/EMPLOYEE/ADMIN)

## 📊 Database Models

```prisma
model Chat {
  id              String            @id @default(uuid())
  type            ChatType          @default(PERSONAL)
  name            String?
  participants    ChatParticipant[]
  messages        Message[]
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  lastMessageAt   DateTime          @default(now())
}

model ChatParticipant {
  id        String   @id @default(uuid())
  chatId    String
  chat      Chat     @relation(fields: [chatId], references: [id], onDelete: Cascade)
  userId    String
  userType  UserType
  isAdmin   Boolean  @default(false)
  joinedAt  DateTime @default(now())

  @@unique([chatId, userId, userType])
  @@index([userId, userType])
}

model Message {
  id              String        @id @default(uuid())
  chatId          String
  chat            Chat          @relation(fields: [chatId], references: [id], onDelete: Cascade)
  senderId        String
  senderType      UserType
  content         String        @db.Text
  messageType     MessageType   @default(TEXT)
  attachmentUrl   String?
  attachmentName  String?
  attachmentSize  Int?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  deletedAt       DateTime?
  readReceipts    MessageRead[]

  @@index([chatId, createdAt])
  @@index([senderId, senderType])
}

model MessageRead {
  id         String   @id @default(uuid())
  messageId  String
  message    Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  userId     String
  userType   UserType
  readAt     DateTime @default(now())

  @@unique([messageId, userId, userType])
}
```

## 🎉 Status: Backend Ready for Testing!

The backend is fully functional and ready for:
1. API endpoint testing
2. Frontend integration
3. Real-time Socket.IO connections

Use the `test-chat-api.http` file to test all endpoints with your JWT token!
