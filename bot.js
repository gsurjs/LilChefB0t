require('dotenv').config();
const tmi = require('tmi.js');

// Parse authorized users from environment variable
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS 
    ? process.env.AUTHORIZED_USERS.split(',').map(user => user.trim().toLowerCase())
    : [];

const config = {
    identity: {
        username: process.env.BOT_USERNAME,
        password: process.env.OAUTH_TOKEN
    },
    channels: [process.env.CHANNEL_NAME]
};

const client = new tmi.Client(config);

// Command cooldowns to prevent spam
const commandCooldowns = new Map();

// Helper function to check if user is authorized admin
const isAuthorizedAdmin = (userstate) => {
    return AUTHORIZED_USERS.includes(userstate.username.toLowerCase());
};

// Commands that work without streamer account access
const commands = {
    '!hello': (channel, userstate) => {
        return `Hello @${userstate.username}! Welcome to the stream! 👋`;
    },
    
    '!dice': (channel, userstate) => {
        const roll = Math.floor(Math.random() * 6) + 1;
        return `🎲 @${userstate.username} rolled a ${roll}!`;
    },
    '!time': (channel, userstate) => {
        return `⏰ Current time: ${new Date().toLocaleTimeString()}`;
    },
    
    '!socials': (channel, userstate) => {
        return `🔗 Follow us! Discord: ${process.env.DISCORD_INVITE} | Twitter: ${process.env.TWITTER_HANDLE} | Follow the stream! 🎯 | Youtube: ${process.env.YOUTUBE_CHANNEL}`;
    },
    
    '!commands': (channel, userstate) => {
        return `Available commands: !hello, !dice, !time, !discord, !socials, !commands`;
    },
    '!discord': (channel, userstate) => {
        const now = Date.now();
        const cooldownTime = 30000; // 30 seconds
        const lastUsed = commandCooldowns.get('discord') || 0;
        
        if (now - lastUsed < cooldownTime) {
            return null; // Don't respond during cooldown
        }
        
        commandCooldowns.set('discord', now);
        return `🎮 Join our Discord community: ${process.env.DISCORD_INVITE} - See you there @${userstate.username}! 🧑🏻‍🍳`;
    },
    '!shutdown': (channel, userstate) => {
        if (userstate.username === 'leg_stiltz' || userstate.username === 'roguedubz' || userstate.username === 'lilchefb0t') {
            client.say(channel, 'Bot shutting down for maintenance...');
            setTimeout(() => process.exit(0), 1000);
            return null;
        } else {
            return `❌ @${userstate.username}, you don't have permission to use this command.`;
        }
    }
};

// Admin commands for authorized users only
const adminCommands = {
    '!shutdown': (channel, userstate) => {
        client.say(channel, `🔧 Bot shutting down by admin @${userstate.username}...`);
        console.log(`Bot shutdown initiated by: ${userstate.username}`);
        setTimeout(() => process.exit(0), 1000);
        return null;
    },
    
    '!restart': (channel, userstate) => {
        client.say(channel, `🔄 Bot restarting by admin @${userstate.username}...`);
        console.log(`Bot restart initiated by: ${userstate.username}`);
        setTimeout(() => process.exit(1), 1000); // Exit code 1 for restart
        return null;
    },
    
    '!adminhelp': (channel, userstate) => {
        return `🔧 Admin commands: !shutdown, !restart, !adminhelp`;
    }
};

// Mod-only commands (since your bot will be a mod)
const modCommands = {
    '!timeout': (channel, userstate, args) => {
        if (args.length > 0) {
            return `/timeout ${args[0]} 60`; // 60 second timeout
        }
    },
    
    '!clear': (channel, userstate) => {
        return '/clear';
    }
};

// Main message handler
client.on('message', async (channel, userstate, message, self) => {
    // Don't respond to the bot's own messages
    if (self) return;
    
    // Log all messages for debugging
    console.log(`[${channel}] ${userstate.username}: ${message}`);
    
    const args = message.split(' ');
    const command = args[0].toLowerCase();
    
    // Check admin commands first
    if (adminCommands[command]) {
        if (isAuthorizedAdmin(userstate)) {
            console.log(`Admin command ${command} executed by: ${userstate.username}`);
            const response = adminCommands[command](channel, userstate, args.slice(1));
            if (response) client.say(channel, response);
        } else {
            console.log(`Unauthorized admin command attempt by: ${userstate.username}`);
            client.say(channel, `❌ @${userstate.username}, admin privileges required for ${command}`);
        }
        return;
    }
    
    // Check moderator commands
    if (modCommands[command]) {
        if (isModerator(userstate)) {
            console.log(`Mod command ${command} executed by: ${userstate.username}`);
            const response = modCommands[command](channel, userstate, args.slice(1));
            if (response) client.say(channel, response);
        } else {
            client.say(channel, `❌ @${userstate.username}, moderator privileges required for ${command}`);
        }
        return;
    }
    
    // Regular commands available to everyone
    if (commands[command]) {
        try {
            let response;
            if (command === '!echo') {
                response = commands[command](channel, userstate, args.slice(1));
            } else {
                response = await commands[command](channel, userstate, args.slice(1));
            }
            
            if (response) {
                console.log(`Command ${command} executed by: ${userstate.username}`);
                client.say(channel, response);
            }
        } catch (error) {
            console.error(`Error executing command ${command}:`, error);
            client.say(channel, `❌ Sorry @${userstate.username}, something went wrong with that command.`);
        }
    }
});

// Connection event handlers
client.on('connected', (address, port) => {
    console.log('='.repeat(50));
    console.log('✅ Twitch Bot Connected Successfully!');
    console.log('='.repeat(50));
    console.log(`🤖 Bot Username: ${process.env.BOT_USERNAME}`);
    console.log(`📺 Channel: ${process.env.CHANNEL_NAME}`);
    console.log(`🔗 Channel URL: https://twitch.tv/${process.env.CHANNEL_NAME}`);
    console.log(`👥 Authorized Admins: ${AUTHORIZED_USERS.join(', ')}`);
    console.log(`🎮 Discord: ${process.env.DISCORD_INVITE || 'Not set'}`);
    console.log('='.repeat(50));
    console.log('💬 Bot is ready for commands!');
    console.log('Type !commands in chat to see available commands');
    console.log('='.repeat(50));
});

client.on('disconnected', (reason) => {
    console.log(`❌ Bot Disconnected: ${reason}`);
});

client.on('reconnect', () => {
    console.log('🔄 Bot Reconnecting...');
});

client.on('join', (channel, username, self) => {
    if (self) {
        console.log(`🎯 Bot joined channel: ${channel}`);
    }
});

// Error handling
client.on('error', (error) => {
    console.error('❌ Bot Error:', error);
});

// Environment variable validation
console.log('🔍 Checking environment variables...');
const requiredVars = ['BOT_USERNAME', 'OAUTH_TOKEN', 'CHANNEL_NAME'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    console.error('Please check your .env file');
    process.exit(1);
}

if (AUTHORIZED_USERS.length === 0) {
    console.warn('⚠️  No authorized admin users set. Admin commands will be disabled.');
}

console.log('✅ Environment variables validated');

// Connect to Twitch
console.log('🔌 Connecting to Twitch...');
client.connect().catch((error) => {
    console.error('❌ Failed to connect to Twitch:', error);
    process.exit(1);
});

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    client.disconnect();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    client.disconnect();
    process.exit(0);
});