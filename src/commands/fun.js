import { pick, cleanUsername } from '../util.js';

const EIGHT_BALL = [
    'It is certain', 'Reply hazy, try again', "Don't count on it",
    'It is decidedly so', 'Ask again later', 'My reply is no',
    'Without a doubt', 'Better not tell you now', 'My sources say no',
    'Yes definitely', 'Cannot predict now', 'Outlook not so good',
    'You may rely on it', 'Concentrate and ask again', 'Very doubtful',
    'As I see it, yes', 'Most likely', 'Outlook good', 'Yes', 'Signs point to yes'
];

const QUOTES = [
    'The only way to do great work is to love what you do. - Steve Jobs',
    'Innovation distinguishes between a leader and a follower. - Steve Jobs',
    'Stay hungry, stay foolish. - Steve Jobs',
    'The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt',
    'It is during our darkest moments that we must focus to see the light. - Aristotle',
    'Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill',
    'The only impossible journey is the one you never begin. - Tony Robbins',
    "Life is what happens to you while you're busy making other plans. - John Lennon"
];

const FACTS = [
    'Honey never spoils! Archaeologists have found edible honey in Egyptian tombs.',
    "A group of flamingos is called a 'flamboyance'.",
    'Octopuses have three hearts and blue blood.',
    "Bananas are berries, but strawberries aren't.",
    "A shrimp's heart is in its head.",
    'Wombat poop is cube-shaped.',
    'The shortest war in history lasted only 38-45 minutes.',
    'Cleopatra lived closer in time to the moon landing than to the construction of the Great Pyramid.'
];

export function funCommands() {
    return [
        {
            name: '!dice',
            help: 'Roll a die. Defaults to 6 sides.',
            usage: '!dice [sides]',
            userCooldown: 3000,
            handler: ({ user, args }) => {
                const sides = Math.max(2, Math.min(Number.parseInt(args[0], 10) || 6, 1000));
                const roll = Math.floor(Math.random() * sides) + 1;
                return `🎲 @${user.displayName} rolled a ${roll}${sides === 6 ? '' : ` (d${sides})`}!`;
            }
        },
        {
            name: '!8ball',
            help: 'Ask the magic 8-ball a question.',
            usage: '!8ball <question>',
            userCooldown: 5000,
            handler: ({ user, args }) =>
                args.length === 0
                    ? `🎱 @${user.displayName}, ask me a question! Usage: !8ball <question>`
                    : `🎱 @${user.displayName}: "${pick(EIGHT_BALL)}"`
        },
        {
            name: '!flip',
            help: 'Flip a coin.',
            userCooldown: 3000,
            handler: ({ user }) => {
                const heads = Math.random() < 0.5;
                return `${heads ? '🪙' : '🥇'} @${user.displayName} flipped ${heads ? 'Heads' : 'Tails'}!`;
            }
        },
        {
            name: '!rng',
            help: 'Random number in a range.',
            usage: '!rng [min] [max]',
            userCooldown: 3000,
            handler: ({ user, args }) => {
                let min = 1;
                let max = 100;
                if (args.length === 1) {
                    max = Number.parseInt(args[0], 10) || 100;
                } else if (args.length >= 2) {
                    min = Number.parseInt(args[0], 10) || 1;
                    max = Number.parseInt(args[1], 10) || 100;
                }
                if (min >= max) return `❌ @${user.displayName}, minimum must be less than maximum!`;
                const result = Math.floor(Math.random() * (max - min + 1)) + min;
                return `🎯 @${user.displayName}: random number between ${min}-${max} is ${result}`;
            }
        },
        {
            name: '!vibes',
            help: 'Vibe check.',
            userCooldown: 10_000,
            handler: ({ user }) =>
                pick([
                    `✨ @${user.displayName} is radiating good vibes today! The energy is immaculate! 🌟`,
                    `🔥 @${user.displayName}'s vibe check: ELITE TIER! 💯`,
                    `🌈 @${user.displayName} is bringing rainbow energy to the chat! 🦄`,
                    `⚡ @${user.displayName}'s vibe frequency: MAXIMUM POWER! 🚀`,
                    `😎 @${user.displayName} is too cool for the vibe check! 🧊`,
                    `🎵 @${user.displayName} is vibing to life's soundtrack! 🎶`
                ])
        },
        {
            name: '!energy',
            help: 'Check your energy level.',
            userCooldown: 10_000,
            handler: ({ user }) => {
                const level = Math.floor(Math.random() * 101);
                const tiers = [
                    [90, '⚡🔥⚡', 'MAXIMUM OVERDRIVE!'],
                    [70, '🚀', 'High energy rocket mode!'],
                    [50, '✨', 'Steady positive energy!'],
                    [30, '☕', 'Could use some coffee...'],
                    [0, '😴', 'Low power mode activated']
                ];
                const [, emoji, description] = tiers.find(([floor]) => level >= floor);
                return `${emoji} @${user.displayName}'s energy level: ${level}% - ${description}`;
            }
        },
        {
            name: '!love',
            help: 'Love compatibility.',
            usage: '!love [@user]',
            userCooldown: 5000,
            handler: ({ user, args }) => {
                const percentage = Math.floor(Math.random() * 101);
                if (args.length === 0) return `💕 @${user.displayName}, you are ${percentage}% loveable today!`;
                return `💕 Love between @${user.displayName} and @${cleanUsername(args[0])}: ${percentage}%`;
            }
        },
        {
            name: '!hug',
            help: 'Give a hug.',
            usage: '!hug [@user]',
            userCooldown: 5000,
            handler: ({ user, args }) =>
                args.length === 0
                    ? `🫂 @${user.displayName} gives everyone a big hug!`
                    : `🫂 @${user.displayName} gives @${cleanUsername(args[0])} a warm hug!`
        },
        {
            name: '!quote',
            help: 'A random inspirational quote.',
            globalCooldown: 15_000,
            handler: () => `💭 ${pick(QUOTES)}`
        },
        {
            name: '!fact',
            help: 'A random fun fact.',
            globalCooldown: 15_000,
            handler: () => `🧠 Fun Fact: ${pick(FACTS)}`
        }
    ];
}
