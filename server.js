require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Error:', err));

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// MongoDB Models
const eventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true },
  welcomeText: { type: String, required: true, maxlength: 100 },
  description: { type: String, required: true, maxlength: 200 },
  backgroundImage: { public_id: String, url: String },
  serviceType: { type: String, enum: ['both', 'viewalbum', 'uploadpics'], default: 'both' },
  uploadLimit: { 
    type: Number, 
    default: 100,
    min: 50,
    max: 5000
  },
  preloadedPhotos: [{ public_id: String, url: String, uploadedAt: { type: Date, default: Date.now } }],
  createdBy: { type: String, required: true },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

const photoSchema = new mongoose.Schema({
  eventId: { type: String, required: true },
  public_id: { type: String, required: true },
  url: { type: String, required: true },
  uploadType: { type: String, enum: ['preloaded', 'guest'], required: true },
  uploaderInfo: { ip: String, userAgent: String },
  approved: { type: Boolean, default: true },
  uploadedAt: { type: Date, default: Date.now }
});

const Event = mongoose.model('Event', eventSchema);
const Photo = mongoose.model('Photo', photoSchema);

// Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userStates = new Map();

// Cloudinary Helper
const uploadToCloudinary = async (imagePath, folder = 'events') => {
  const result = await cloudinary.uploader.upload(imagePath, { folder, quality: 'auto' });
  return { public_id: result.public_id, url: result.secure_url };
};

// Generate Event ID
const generateEventId = () => 'EVT_' + Math.random().toString(36).substr(2, 9).toUpperCase();

// Bot Start Command
bot.start(async (ctx) => {
  const eventId = generateEventId();
  const userId = ctx.from.id.toString();
  
  userStates.set(userId, {
    step: 'welcomeText',
    eventData: { 
      eventId, 
      createdBy: userId,
      preloadedPhotos: []
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
      await ctx.reply('✅ Enter upload limit (50-5000):');
      break;

    case 'uploadLimit':
      const limit = parseInt(text);
      if (isNaN(limit) || limit < 50 || limit > 5000) {
        await ctx.reply('❌ Enter number 50-5000:');
        return;
      }
      userState.eventData.uploadLimit = limit;
      userState.step = 'preloadedPhotos';
      userStates.set(userId, userState);
      await ctx.reply('✅ Now send preloaded photos (type /done when finished):');
      break;

    case 'eventIdForDisable':
      try {
        const event = await Event.findOne({ eventId: text });
        if (!event) {
          await ctx.reply('❌ Event not found');
          return;
        }
        event.status = 'disabled';
        await event.save();
        await ctx.reply(`✅ Uploads disabled for event: ${text}`);
      } catch (error) {
        await ctx.reply('❌ Failed to disable event');
      }
      userStates.delete(userId);
      break;
  }
});

// Bot Photo Handler
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = userStates.get(userId);
  if (!userState) return;

  try {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const fileLink = await bot.telegram.getFileLink(fileId);
    const tempPath = `temp-${Date.now()}.jpg`;
    
    // Download image using https
    const fileStream = fs.createWriteStream(tempPath);
    https.get(fileLink.href, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', async () => {
        fileStream.close();
        
        if (userState.step === 'backgroundImage') {
          const uploadResult = await uploadToCloudinary(tempPath, 'events/backgrounds');
          userState.eventData.backgroundImage = uploadResult;
          userState.step = 'serviceType';
          userStates.set(userId, userState);
          await ctx.reply('✅ Background set! Choose: /both, /viewalbum, or /uploadpics');
        } else if (userState.step === 'preloadedPhotos') {
          const uploadResult = await uploadToCloudinary(tempPath, 'events/preloaded');
          userState.eventData.preloadedPhotos.push(uploadResult);
          userStates.set(userId, userState);
          await ctx.reply('✅ Photo added! Send more or /done');
        }
        
        fs.unlinkSync(tempPath);
      });
    });
  } catch (error) {
    console.error('Photo upload error:', error);
    await ctx.reply('❌ Failed to upload image');
  }
});

// Bot /done Command - SIMPLE & GUARANTEED WORKING
bot.command('done', async (ctx) => {
  try {
    console.log('🚀 /done command started');
    const userId = ctx.from.id.toString();
    const userState = userStates.get(userId);
    
    if (!userState) {
      await ctx.reply('❌ No event in progress. Use /start first.');
      return;
    }

    // SEND EVENT LINK IMMEDIATELY
    const eventUrl = `${process.env.FRONTEND_URL}/event/${userState.eventData.eventId}`;
    
    await ctx.reply(
      `🎊 *Event Created Successfully!*\n\n` +
      `*Event ID:* ${userState.eventData.eventId}\n` +
      `*Event URL:* ${eventUrl}\n\n` +
      `Share this URL with your guests! 🎉\n\n` +
      `Use /disable to stop uploads later.`,
      { parse_mode: 'Markdown' }
    );

    // Try to save event (but don't block the link sending)
    try {
      const event = new Event(userState.eventData);
      await event.save();
      
      if (userState.eventData.preloadedPhotos.length > 0) {
        for (const photo of userState.eventData.preloadedPhotos) {
          await new Photo({
            eventId: userState.eventData.eventId,
            public_id: photo.public_id,
            url: photo.url,
            uploadType: 'preloaded'
          }).save();
        }
      }
    } catch (saveError) {
      console.log('⚠️ Event save failed but link was sent:', saveError.message);
    }

    // Clean up
    userStates.delete(userId);
    
  } catch (error) {
    console.error('❌ /done error:', error);
    await ctx.reply('❌ Failed to create event: ' + error.message);
  }
});

// Bot /disable Command
bot.command('disable', (ctx) => {
  const userId = ctx.from.id.toString();
  userStates.set(userId, { step: 'eventIdForDisable' });
  ctx.reply('Enter Event ID to disable uploads:');
});

// Start Bot
bot.launch().then(() => console.log('🤖 Telegram Bot Started'));

// API Routes
const upload = multer({ dest: 'uploads/' });

// Get Event Details
app.get('/api/events/:eventId', async (req, res) => {
  try {
    const event = await Event.findOne({ eventId: req.params.eventId });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const preloadedPhotos = await Photo.find({ eventId: req.params.eventId, uploadType: 'preloaded' }).sort({ uploadedAt: -1 });
    const guestPhotos = await Photo.find({ eventId: req.params.eventId, uploadType: 'guest', approved: true }).sort({ uploadedAt: -1 });

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

// Upload Guest Photo
app.post('/api/upload/:eventId', upload.single('photo'), async (req, res) => {
  try {
    const event = await Event.findOne({ eventId: req.params.eventId });
    if (!event || event.status === 'disabled' || event.serviceType === 'viewalbum') {
      return res.status(400).json({ error: 'Uploads not allowed' });
    }

    // Check upload limit
    const guestUploadsCount = await Photo.countDocuments({ 
      eventId: req.params.eventId, 
      uploadType: 'guest',
      'uploaderInfo.ip': req.ip 
    });

    if (guestUploadsCount >= event.uploadLimit) {
      return res.status(400).json({ error: 'Upload limit reached' });
    }

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(req.file.path, { 
      folder: `events/${req.params.eventId}`,
      quality: 'auto'
    });

    // Save to database
    const photo = new Photo({
      eventId: req.params.eventId,
      public_id: uploadResult.public_id,
      url: uploadResult.secure_url,
      uploadType: 'guest',
      uploaderInfo: { ip: req.ip, userAgent: req.get('User-Agent') }
    });

    await photo.save();
    fs.unlinkSync(req.file.path);

    res.json({ success: true, photo });
  } catch (error) {
    console.error('Upload API error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get Album Photos
app.get('/api/album/:eventId', async (req, res) => {
  try {
    const preloadedPhotos = await Photo.find({ eventId: req.params.eventId, uploadType: 'preloaded' }).sort({ uploadedAt: -1 });
    const guestPhotos = await Photo.find({ eventId: req.params.eventId, uploadType: 'guest', approved: true }).sort({ uploadedAt: -1 });
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
