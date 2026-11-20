import { config } from '../config.js';
import { pick } from '../util.js';

export const socialsLine = () => {
    const links = [
        config.socials.discord && `Discord: ${config.socials.discord}`,
        config.socials.twitter && `Twitter: ${config.socials.twitter}`,
        config.socials.youtube && `YouTube: ${config.socials.youtube}`
    ].filter(Boolean);

    return links.length > 0
        ? `🔗 Follow the chef! ${links.join(' | ')} 🎯`
        : '🔗 No social links are configured yet.';
};

export function socialCommands() {
    return [
        {
            name: '!hello',
            aliases: ['!hi'],
            help: 'Say hello.',
            userCooldown: 10_000,
            handler: ({ user }) =>
                pick([
                    `Hello @${user.displayName}! Welcome to the stream! 👋`,
                    `Hey there @${user.displayName}! Glad you're here! 🎉`,
                    `Welcome @${user.displayName}! Hope you enjoy the stream! ✨`,
                    `@${user.displayName} just entered the chat! What's good? 🔥`
                ])
        },
        {
            name: '!socials',
            help: 'All the channel links.',
            globalCooldown: 30_000,
            handler: () => socialsLine()
        },
        {
            name: '!discord',
            help: 'Discord invite.',
            globalCooldown: 30_000,
            handler: ({ user }) =>
                config.socials.discord
                    ? `🎮 Join our Discord community: ${config.socials.discord} - See you there @${user.displayName}! 🧑🏻‍🍳`
                    : `@${user.displayName}, no Discord invite is configured yet.`
        },
        {
            name: '!prime',
            help: 'How to use your free Prime sub.',
            globalCooldown: 60_000,
            handler: () =>
                '🎮 Amazon Prime members get a FREE Twitch subscription every month! ' +
                "Don't forget to claim yours and maybe support your favorite 👨🏻‍🍳? (We'd be honored 🙏) 💜 " +
                'Manage your Prime Gaming benefits: https://gaming.amazon.com/links/twitch/manage'
        },
        {
            name: '!rules',
            help: 'Channel rules.',
            globalCooldown: 30_000,
            handler: () =>
                '📋 Stream Rules: • Keep language clean • No politics/current events discussion • ' +
                'Backseating permitted as long as it is reasonable 🎯'
        },
        {
            name: '!lurk',
            help: 'Enter lurk mode.',
            userCooldown: 30_000,
            handler: ({ user }) =>
                pick([
                    `Thanks for lurking @${user.displayName}! Enjoy the stream! 👻`,
                    `Happy lurking @${user.displayName}! 🕵️`,
                    `@${user.displayName} is now in lurk mode! 🥷`,
                    `Lurk away @${user.displayName}! We appreciate you being here! 💜`
                ])
        },
        {
            name: '!unlurk',
            help: 'Come back from lurking.',
            userCooldown: 30_000,
            handler: ({ user }) =>
                pick([
                    `Welcome back @${user.displayName}! 🎉`,
                    `@${user.displayName} has emerged from the shadows! 👋`,
                    `Look who's back! Hey @${user.displayName}! ✨`,
                    `@${user.displayName} decided to join the conversation! 🗣️`
                ])
        }
    ];
}
