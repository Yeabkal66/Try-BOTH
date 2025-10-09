require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const admin = require('firebase-admin');

// Firebase Admin Initialization
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Telegram Bot
let bot;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
} else {
  console.log('⚠️ Telegram Bot Token not found');
}

const userStates = new Map();

// Cloudinary Helper: Upload remote URL directly to Cloudinary
const uploadRemoteUrlToCloudinary = async (url, folder = 'events') => {
  const result = await cloudinary.uploader.upload(url, { 
    folder, 
    quality: 'auto' 
  });
  return { public_id: result.public_id, url: result.secure_url };
};

// Generate Event ID
const generateEventId = () => 'EVT_' + Math.random().toString(36).substr(2, 9).toUpperCase();

// Function to automatically complete event creation
const autoCompleteEvent = async (ctx, userState) => {
  try {
    await ctx.reply('⏳ All photos received! Creating your event...');

    // SAVE EVENT TO FIRESTORE
    const eventData = {
      ...userState.eventData,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('events').doc(userState.eventData.eventId).set(eventData);
    console.log('✅ Event saved to Firestore');

    // SAVE PRELOADED PHOTOS TO FIRESTORE
    if (userState.eventData.preloadedPhotos.length > 0) {
      console.log('💾 Saving photos to Firestore...');
      
      for (const photo of userState.eventData.preloadedPhotos) {
        const photoData = {
          eventId: userState.eventData.eventId,
          public_id: photo.public_id,
          url: photo.url,
          uploadType: 'preloaded',
          uploadedAt: photo.uploadedAt || new Date(),
          approved: true
        };
        
        await db.collection('photos').add(photoData);
        console.log('✅ Photo saved:', photo.public_id);
      }
      console.log('🎊 All photos saved to Firestore');
    }

    const eventUrl = `${process.env.FRONTEND_URL}/event/${userState.eventData.eventId}`;
    
    await ctx.reply(
      `🎊 *Event Created Successfully!*\n\n` +
      `*Event ID:* ${userState.eventData.eventId}\n` +
      `*Event URL:* ${eventUrl}\n\n` +
      `Share this URL with your guests! 🎉\n\n` +
      `Use /disable to stop uploads later.`,
      { parse_mode: 'Markdown' }
    );

    // Clean up user state
    userStates.delete(userState.eventData.createdBy);
    console.log('✅ User state cleaned up');
    
  } catch (error) {
    console.error('❌ Auto-complete event failed:', error);
    await ctx.reply('❌ Failed to create event: ' + error.message);
  }
};

// Bot commands only if bot is initialized
if (bot) {
  // Bot Start Command
  bot.start(async (ctx) => {
    const eventId = generateEventId();
    const userId = ctx.from.id.toString();
    
    userStates.set(userId, {
      step: 'welcomeText',
      eventData: { 
        eventId, 
        createdBy: userId,
        preloadedPhotos: [],
        status: 'active',
        uploadedCount: 0,
        expectedPhotoCount: 0
      }
    });

    await ctx.reply(`🎉 Event Created! ID: ${eventId}\nEnter welcome text (max 100 chars):`);
  });

  // Bot Text Handler
  bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = userStates.get(userId);
    if (!userState) return;

    const text = ctx.message.text;

    switch (userState.step) {
      case 'welcomeText':
        if (text.length > 100) {
          await ctx.reply('❌ Too long! Max 100 chars:');
          return;
        }
        userState.eventData.welcomeText = text;
        userState.step = 'description';
        userStates.set(userId, userState);
        await ctx.reply('✅ Now enter description (max 200 chars):');
        break;

      case 'description':
        if (text.length > 200) {
          await ctx.reply('❌ Too long! Max 200 chars:');
          return;
        }
        userState.eventData.description = text;
        userState.step = 'backgroundImage';
        userStates.set(userId, userState);
        await ctx.reply('✅ Now send background image:');
        break;

      case 'serviceType':
        if (!['/both', '/viewalbum', '/uploadpics'].includes(text)) {
          await ctx.reply('❌ Use /both, /viewalbum, or /uploadpics');
          return;
        }
        userState.eventData.serviceType = text.replace('/', '');
        userState.step = 'uploadLimit';
        userStates.set(userId, userState);
        await ctx.reply('✅ Enter upload limit for guests (50-5000):');
        break;

      case 'uploadLimit':
        const limit = parseInt(text);
        if (isNaN(limit) || limit < 50 || limit > 5000) {
          await ctx.reply('❌ Enter number 50-5000:');
          return;
        }
        userState.eventData.uploadLimit = limit;
        userState.step = 'expectedPhotoCount';
        userStates.set(userId, userState);
        await ctx.reply('✅ How many preloaded photos will you send?');
        break;

      case 'expectedPhotoCount':
        const expectedCount = parseInt(text);
        if (isNaN(expectedCount) || expectedCount < 1) {
          await ctx.reply('❌ Please enter a valid number (1 or more):');
          return;
        }
        userState.eventData.expectedPhotoCount = expectedCount;
        userState.step = 'preloadedPhotos';
        userStates.set(userId, userState);
        await ctx.reply(`✅ Great! Now send ${expectedCount} preloaded photos. I'll automatically create the event when all photos are uploaded.`);
        break;

      case 'eventIdForDisable':
        try {
          const eventDoc = await db.collection('events').doc(text).get();
          if (!eventDoc.exists) {
            await ctx.reply('❌ Event not found');
            return;
          }
          await db.collection('events').doc(text).update({
            status: 'disabled',
            updatedAt: new Date()
          });
          await ctx.reply(`✅ Uploads disabled for event: ${text}`);
        } catch (error) {
          await ctx.reply('❌ Failed to disable event');
        }
        userStates.delete(userId);
        break;
    }
  });

  // Bot Photo Handler - WITH AUTO-COMPLETE
  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = userStates.get(userId);
    if (!userState) return;

    try {
      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      const fileLink = await bot.telegram.getFileLink(fileId);

      if (userState.step === 'backgroundImage') {
        const uploadResult = await uploadRemoteUrlToCloudinary(fileLink.href, 'events/backgrounds');
        userState.eventData.backgroundImage = uploadResult;
        userState.step = 'serviceType';
        userStates.set(userId, userState);
        await ctx.reply('✅ Background set! Choose: /both, /viewalbum, or /uploadpics');
      } else if (userState.step === 'preloadedPhotos') {
        const uploadResult = await uploadRemoteUrlToCloudinary(fileLink.href, 'events/preloaded');
        
        // Add photo to preloaded photos
        userState.eventData.preloadedPhotos.push({
          public_id: uploadResult.public_id,
          url: uploadResult.url,
          uploadedAt: new Date()
        });
        
        // Increment uploaded count
        userState.eventData.uploadedCount++;
        
        userStates.set(userId, userState);
        
        const remaining = userState.eventData.expectedPhotoCount - userState.eventData.uploadedCount;
        
        if (remaining > 0) {
          await ctx.reply(`✅ Photo ${userState.eventData.uploadedCount}/${userState.eventData.expectedPhotoCount} added! ${remaining} more to go.`);
        } else {
          // All photos uploaded - auto complete event
          await ctx.reply(`✅ Final photo ${userState.eventData.uploadedCount}/${userState.eventData.expectedPhotoCount} added!`);
          await autoCompleteEvent(ctx, userState);
        }
      }
    } catch (error) {
      console.error('Photo upload error:', error);
      await ctx.reply('❌ Failed to upload image');
    }
  });

  // Bot /disable Command (KEPT)
  bot.command('disable', (ctx) => {
    const userId = ctx.from.id.toString();
    userStates.set(userId, { step: 'eventIdForDisable' });
    ctx.reply('Enter Event ID to disable uploads:');
  });

  // Start Bot only if token exists
  bot.launch().then(() => console.log('🤖 Telegram Bot Started'))
    .catch(err => console.error('❌ Bot failed to start:', err));
}

// MEMORY STORAGE FOR GUEST UPLOADS
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// API Routes

// Get Event Details - FIRESTORE VERSION
app.get('/api/events/:eventId', async (req, res) => {
  try {
    const eventDoc = await db.collection('events').doc(req.params.eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventDoc.data();

    // Get preloaded photos
    const preloadedPhotosSnapshot = await db.collection('photos')
      .where('eventId', '==', req.params.eventId)
      .where('uploadType', '==', 'preloaded')
      .orderBy('uploadedAt', 'desc')
      .get();
    
    const preloadedPhotos = preloadedPhotosSnapshot.docs.map(doc => doc.data());

    // Get guest photos
    const guestPhotosSnapshot = await db.collection('photos')
      .where('eventId', '==', req.params.eventId)
      .where('uploadType', '==', 'guest')
      .where('approved', '==', true)
      .orderBy('uploadedAt', 'desc')
      .get();
    
    const guestPhotos = guestPhotosSnapshot.docs.map(doc => doc.data());

    res.json({
      event,
      preloadedPhotos,
      guestPhotos,
      uploadEnabled: event.status === 'active' && event.serviceType !== 'viewalbum'
    });
  } catch (error) {
    console.error('Events API error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload Guest Photo - FIRESTORE VERSION
app.post('/api/upload/:eventId', upload.single('photo'), async (req, res) => {
  try {
    const eventDoc = await db.collection('events').doc(req.params.eventId).get();
    if (!eventDoc.exists) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const event = eventDoc.data();
    
    if (event.status === 'disabled' || event.serviceType === 'viewalbum') {
      return res.status(400).json({ error: 'Uploads not allowed' });
    }

    // Check upload limit
    const guestPhotosSnapshot = await db.collection('photos')
      .where('eventId', '==', req.params.eventId)
      .where('uploadType', '==', 'guest')
      .where('uploaderInfo.ip', '==', req.ip)
      .get();

    if (guestPhotosSnapshot.size >= event.uploadLimit) {
      return res.status(400).json({ error: 'Upload limit reached' });
    }

    // UPLOAD FROM MEMORY BUFFER
    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataUri = "data:" + req.file.mimetype + ";base64," + b64;
    
    const uploadResult = await cloudinary.uploader.upload(dataUri, { 
      folder: `events/${req.params.eventId}`,
      quality: 'auto'
    });

    // Save to Firestore
    const photoData = {
      eventId: req.params.eventId,
      public_id: uploadResult.public_id,
      url: uploadResult.secure_url,
      uploadType: 'guest',
      uploaderInfo: { 
        ip: req.ip, 
        userAgent: req.get('User-Agent') 
      },
      approved: true,
      uploadedAt: new Date()
    };

    await db.collection('photos').add(photoData);

    res.json({ success: true, photo: photoData });
  } catch (error) {
    console.error('Upload API error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get Album Photos - FIRESTORE VERSION
app.get('/api/album/:eventId', async (req, res) => {
  try {
    // Get preloaded photos
    const preloadedPhotosSnapshot = await db.collection('photos')
      .where('eventId', '==', req.params.eventId)
      .where('uploadType', '==', 'preloaded')
      .orderBy('uploadedAt', 'desc')
      .get();
    
    const preloadedPhotos = preloadedPhotosSnapshot.docs.map(doc => doc.data());

    // Get guest photos
    const guestPhotosSnapshot = await db.collection('photos')
      .where('eventId', '==', req.params.eventId)
      .where('uploadType', '==', 'guest')
      .where('approved', '==', true)
      .orderBy('uploadedAt', 'desc')
      .get();
    
    const guestPhotos = guestPhotosSnapshot.docs.map(doc => doc.data());

    res.json({ preloadedPhotos, guestPhotos });
  } catch (error) {
    console.error('Album API error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ message: 'Event Photo Backend is running!' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
