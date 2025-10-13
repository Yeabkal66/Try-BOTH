require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Error:', err));

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB Schemas
const eventSchema = new mongoose.Schema({
  eventId: { type: String, unique: true, required: true },
  welcomeText: String,
  description: String,
  backgroundImage: Object,
  uploadLimit: Number,
  viewAlbumLink: String,
  status: { type: String, default: 'active' },
  createdBy: String,
  createdAt: { type: Date, default: Date.now }
});

const photoSchema = new mongoose.Schema({
  eventId: String,
  public_id: String,
  url: String,
  uploadType: String,
  uploaderInfo: Object,
  approved: { type: Boolean, default: true },
  uploadedAt: { type: Date, default: Date.now }
});

const Event = mongoose.model('Event', eventSchema);
const Photo = mongoose.model('Photo', photoSchema);

// Telegram Bot
let bot;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
} else {
  console.log('⚠️ Telegram Bot Token not found');
}

const userStates = new Map();

// Upload Helper
const uploadRemoteUrlToCloudinary = async (url, folder = 'events') => {
  const result = await cloudinary.uploader.upload(url, { folder, quality: 'auto' });
  return { public_id: result.public_id, url: result.secure_url };
};

// Generate Event ID
const generateEventId = () => 'EVT_' + Math.random().toString(36).substr(2, 9).toUpperCase();

// Auto-complete event
const autoCompleteEvent = async (ctx, userState) => {
  try {
    await ctx.reply('⏳ All photos received! Creating your event...');

    const eventData = {
      ...userState.eventData,
      createdAt: new Date(),
    };

    await Event.create(eventData);
    console.log('✅ Event saved to MongoDB');

    if (userState.eventData.preloadedPhotos.length > 0) {
      const photoDocs = userState.eventData.preloadedPhotos.map(photo => ({
        ...photo,
        eventId: userState.eventData.eventId,
        uploadType: 'preloaded'
      }));
      await Photo.insertMany(photoDocs);
      console.log('✅ Preloaded photos saved');
    }

    const eventUrl = `${process.env.FRONTEND_URL}/event/${userState.eventData.eventId}`;
    await ctx.reply(
      `🎊 *Event Created Successfully!*\n\n` +
      `*Event ID:* ${userState.eventData.eventId}\n` +
      `*Guest Upload URL:* ${eventUrl}\n\n` +
      `Share this link with guests! 🎉`,
      { parse_mode: 'Markdown' }
    );

    userStates.delete(userState.eventData.createdBy);
  } catch (error) {
    console.error('❌ Auto-complete event failed:', error);
    await ctx.reply('❌ Failed to create event: ' + error.message);
  }
};

// BOT FLOW
if (bot) {
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
        expectedPhotoCount: 0,
        viewAlbumLink: ''
      }
    });

    await ctx.reply(`🎉 Event Created! ID: ${eventId}\nEnter welcome text (max 100 chars):`);
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = userStates.get(userId);
    if (!userState) return;

    const text = ctx.message.text;

    switch (userState.step) {
      case 'welcomeText':
        if (text.length > 100) return ctx.reply('❌ Too long! Max 100 chars.');
        userState.eventData.welcomeText = text;
        userState.step = 'description';
        return ctx.reply('✅ Now enter description (max 200 chars):');

      case 'description':
        if (text.length > 200) return ctx.reply('❌ Too long! Max 200 chars.');
        userState.eventData.description = text;
        userState.step = 'backgroundImage';
        return ctx.reply('✅ Now send background image:');

      case 'viewAlbumLink':
        if (text.toLowerCase() === 'skip') {
          userState.eventData.viewAlbumLink = '';
          userState.step = 'uploadLimit';
          return ctx.reply('✅ Skipped. Enter upload limit (50–5000):');
        } else if (text.startsWith('http://') || text.startsWith('https://')) {
          userState.eventData.viewAlbumLink = text;
          userState.step = 'uploadLimit';
          return ctx.reply('✅ Link saved! Enter upload limit (50–5000):');
        } else {
          return ctx.reply('❌ Invalid URL. Type "skip" or a valid URL.');
        }

      case 'uploadLimit':
        const limit = parseInt(text);
        if (isNaN(limit) || limit < 50 || limit > 5000)
          return ctx.reply('❌ Enter number 50–5000:');
        userState.eventData.uploadLimit = limit;
        userState.step = 'expectedPhotoCount';
        return ctx.reply('✅ How many preloaded photos will you send?');

      case 'expectedPhotoCount':
        const expectedCount = parseInt(text);
        if (isNaN(expectedCount) || expectedCount < 1)
          return ctx.reply('❌ Enter valid number (≥1)');
        userState.eventData.expectedPhotoCount = expectedCount;
        userState.step = 'preloadedPhotos';
        return ctx.reply(`✅ Great! Send ${expectedCount} photos now.`);
    }
  });

  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = userStates.get(userId);
    if (!userState) return;

    const fileId = ctx.message.photo.slice(-1)[0].file_id;
    const fileLink = await bot.telegram.getFileLink(fileId);

    if (userState.step === 'backgroundImage') {
      const uploadResult = await uploadRemoteUrlToCloudinary(fileLink.href, 'events/backgrounds');
      userState.eventData.backgroundImage = uploadResult;
      userState.step = 'viewAlbumLink';
      return ctx.reply('✅ Background set! Send view album link or type "skip".');
    } else if (userState.step === 'preloadedPhotos') {
      const uploadResult = await uploadRemoteUrlToCloudinary(fileLink.href, 'events/preloaded');
      userState.eventData.preloadedPhotos.push({
        public_id: uploadResult.public_id,
        url: uploadResult.url,
        uploadedAt: new Date()
      });
      userState.eventData.uploadedCount++;

      const remaining = userState.eventData.expectedPhotoCount - userState.eventData.uploadedCount;
      if (remaining > 0) {
        ctx.reply(`✅ ${userState.eventData.uploadedCount}/${userState.eventData.expectedPhotoCount} uploaded.`);
      } else {
        ctx.reply(`✅ All ${userState.eventData.uploadedCount} photos uploaded!`);
        await autoCompleteEvent(ctx, userState);
      }
    }
  });

  bot.launch().then(() => console.log('🤖 Telegram Bot Started'));
}

// Guest Upload Endpoint
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post('/api/upload/:eventId', upload.single('photo'), async (req, res) => {
  try {
    const event = await Event.findOne({ eventId: req.params.eventId });
    if (!event || event.status === 'disabled' || event.viewAlbumLink)
      return res.status(400).json({ error: 'Uploads not allowed' });

    const b64 = Buffer.from(req.file.buffer).toString('base64');
    const dataUri = "data:" + req.file.mimetype + ";base64," + b64;
    const uploadResult = await cloudinary.uploader.upload(dataUri, { folder: `events/${req.params.eventId}` });

    const photo = await Photo.create({
      eventId: req.params.eventId,
      public_id: uploadResult.public_id,
      url: uploadResult.secure_url,
      uploadType: 'guest',
      uploaderInfo: { ip: req.ip, userAgent: req.get('User-Agent') },
      approved: true
    });

    res.json({ success: true, photo });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get Event Details
app.get('/api/events/:eventId', async (req, res) => {
  try {
    const event = await Event.findOne({ eventId: req.params.eventId });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const preloadedPhotos = await Photo.find({ eventId: req.params.eventId, uploadType: 'preloaded' });
    const guestPhotos = await Photo.find({ eventId: req.params.eventId, uploadType: 'guest', approved: true });

    res.json({ event, preloadedPhotos, guestPhotos });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Health
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💾 MongoDB connected and saving data`);
});
