const Discord = require('discord.js');
const client = new Discord.Client();
const auth = require('./auth.json');
const fs = require('fs');
const snekfetch = require('snekfetch');
const config = require('./config.json');
const prefix = config.commandPrefix;

let gamesById = new Map();
let unregisterCommandsNotYetConfirmed = new Map();
let shutdownCommandsNotYetConfirmed = new Map();
let adminDM;

//client behavior
//---------------
client.on('ready', () => {
	console.log('logged in as ' + client.user.tag + '!');

	//load games from file
	if (!fs.existsSync('games.dat')) {
		console.log('games.dat not found, generating empty games.dat');
		saveGames();
	} else {
		fs.readFile('games.dat', 'utf8', (err, data) => {
			if (err) throw err;
			try {
				gamesById = gamesFromString(data);
				console.log(gamesById);
			} catch(err) {
				logError('Error parsing games.dat: ', err);
			}
		});
	}
	//create admin dm channel for error messages
	client.fetchUser(config.adminId)
		.then(adminUser => adminUser.createDM())
		.then(DM => adminDM = DM)
		.catch(logError);

	console.log('starting core loop');
	client.setInterval(tick, 1000 * config.tickInSeconds);
	client.setInterval(decay, 1000*60*60*24);
});

client.on('message', msg => {
	try {
		if (msg.channel.type == 'dm' && !msg.author.bot) {
			msg.channel.send('Bot commands do not work in direct message. Go to a channel to get access to bot commands');
			help(msg);
			return;
		}
		if (msg.channel.type != 'text' && msg.channel.type != 'voice') return;

		if (msg.content.startsWith(prefix)) {
			console.log('incoming command: ' + msg.content);
			let split = msg.content.substr(prefix.length).split(' ');
			let command = split.shift().toLowerCase();
			let args = split;
			if (command === 'help') {
				help(msg);
			} else if (command === 'register') {
				register(msg, args);
			} else if (command === 'unregister') {
				unregister(msg);
			} else if (command === 'confirm') {
				confirmUnregister(msg);
			} else if (command === 'claim') {
				claim(msg, args);
			} else if (command === 'unclaim') {
				unclaim(msg);
			} else if (command === 'assign') {
				fun_assign(msg, args);
			} else if (command === 'unassign') {
				unassign(msg, args);
			} else if (command === 'who') {
				who(msg);
			} else if (command === 'gamehost') {
				gamehost(msg);
			} else if (command === 'time' || command === 'timer') {
				time(msg);
			} else if (command === 'undone') {
				undone(msg);
			} else if (command === 'silent') {
				silent(msg);
			} else if (command === 'enable') {
				enable(msg);
			} else if (command === 'disable') {
				disable(msg);
			} else if (command === 'broadcast') {
				broadcast(msg, args)
			} else if (command === 'shutdown') {
				shutdown(msg);
			} else if (command === 'confirmshutdown') {
				confirmShutdown(msg);
			} else {
				msg.channel.send('unknown command. Use ' + prefix + 'help for a list of all commands');
			}
		}
	}
	catch(err) {
		handleError(msg.channel, err);
	}
});

console.log('attempting Discord login');
client.login(auth.token);

//core loop and associated functions, also game decay
//---------------------------------------------------
function tick() {
	console.log('tick');
	for (let game of gamesById.values()) {
		if (!game.isEnabled) break;
		getLlamaString(game.name)
			.then(llamastring => {
				if (llamastring == undefined) return;//game is inactive or doesn't exist

				let numllDataTries = 0;
				let llData;
				do {
					llData = new LlamaData(llamastring);
					if (numllDataTries > 0) logError('Malformed LlamaData');
					if (numllDataTries > 5) {
						throw new Error('Malformed LlamaData: possibly cannot reach Llamaserver website');
					}
					numllDataTries++;
				} while(llData.isMalformed);

				removeDroppedPlayers(game, llData);
				notifyLate(game, llData, config.timerLong, false);
				notifyLate(game, llData, config.timerShort, true);
				notifyLast(game, llData);
				checkNewTurn(game, llData);
			})
			.then(saveGames)
			.catch(err => {
				let channel = client.channels.get(game.channelId);
				handleError(channel, err);
			});
	}
}

function removeDroppedPlayers(game, llData) {
	for (let player of game.playersById.values()) {
		if (!llData.isDoneByNation.has(player.nation)) {
			game.playersById.delete(player.id);
		}
	}
}

function notifyLate(game, llData, timer, isUrgent) {
	//reset flags if appropriate
	if (llData.minsLeft > timer) {
		if (isUrgent) {
			game.isNotifiedUrgent = false;
		} else {
			game.isNotified = false;
		}
		return;
	}

	let isNotified = isUrgent ? game.isNotifiedUrgent : game.isNotified;
	if (!isNotified && Array.from(llData.isDoneByNation.values()).includes(false)) {
		//determine who needs to be notified
		let gamehostIdsToNotify = game.gamehosts;
		let playerIdsToNotify = new Set();
		let unclaimedNations = new Set(llData.isDoneByNation.keys());//will remove the claimed nations in the following for loop
		for (let player of game.playersById.values()) {
			if (llData.isDoneByNation.get(player.nation) === false) {
				playerIdsToNotify.add(player.id);
				gamehostIdsToNotify.delete(player.id);//no need to notify the person twice
			}
			unclaimedNations.delete(player.nation);
		}
		//send out notifications
		if (game.isSilentMode) {
			for (let playerId of playerIdsToNotify) {
				client.fetchUser(playerId)
					.then(user => user.createDM())
					.then(dm => dm.send('' + llData.minsLeft + ' minutes left in ' + game.name))
					.catch(logError);
			}
			for (let gamehostId of gamehostIdsToNotify) {
				client.fetchUser(gamehostId)
					.then(user => user.createDM())
					.then(dm => dm.send('' + llData.minsLeft + ' minutes left in ' + game.name))
					.catch(logError);
			}
		} else {
			let channel = client.channels.get(game.channelId);
			let notificationString = '';
			for (id of playerIdsToNotify) {
				notificationString += '<@' + id + '>, ';
			}
			for (nation of unclaimedNations) {
				notificationString += nation + ', ';
			}
			notificationString = notificationString.substring(0, notificationString.length - 2);
			notificationString += ' ' + llData.minsLeft + ' minutes to do your turn';
			if (isUrgent) notificationString += '!';
			for (id of gamehostIdsToNotify) {
				notificationString += ' <@' + id + '>';
			}
			spamProtectedSend(channel, notificationString);
		}
		//update game flags
		if (isUrgent) {
			game.isNotifiedUrgent = true;
		} else {
			game.isNotified = true;
		}
	}
}

function notifyLast(game, llData) {
	let numNationsNotDone = 0;
	let lastNation;
	for (let entry of llData.isDoneByNation) {
		if (!entry[1]) {
			numNationsNotDone++;
			lastNation = entry[0];
		}
	}
	if (numNationsNotDone > 1) {//reset flag
		game.isNotifiedLast = false;
		return;
	}

	if (numNationsNotDone == 1) {
		let lastPlayer = undefined;
		for (let player of game.playersById.values()) {
			if (player.nation == lastNation) lastPlayer = player;
		}
		if (lastPlayer != undefined && !game.isNotifiedLast) {
			let channel = client.channels.get(game.channelId);
			if (game.isSilentMode) {
				client.fetchUser(lastPlayer.id)
					.then(user => user.createDM())
					.then(dm => dm.send('Last undone turn in ' + game.name))
					.catch(err => handleError(adminDM, err));
			} else {
				spamProtectedSend(channel, '<@' + lastPlayer.id + '> last');
			}
			game.isNotifiedLast = true;
		}
	}
}

function checkNewTurn(game, llData) {
	let someoneHasDoneTheirTurn = false;
	for (let turnDone of llData.isDoneByNation.values()) {
		if (turnDone) someoneHasDoneTheirTurn = true;
	}	
	if (someoneHasDoneTheirTurn) {
		game.isNotifiedNewTurn = false;
		return;
	}	

	if (!someoneHasDoneTheirTurn && !game.isNotifiedNewTurn) {
		let channel = client.channels.get(game.channelId);
		
		//send out staling information
		getStalerString(game.name)
			.then(stalerString => {
				if (stalerString.length > 0) channel.send(stalerString);
			});

		game.isNotifiedNewTurn = true;
		let toNotifyNewTurn = new Set();
		for (let player of game.playersById.values()) {
			toNotifyNewTurn.add(player);
		}
		if (toNotifyNewTurn.size == 0) return; 

		//send out notification
		if (game.isSilentMode) {
			for (let player of toNotifyNewTurn) {
				client.fetchUser(player.id)
					.then(user => user.createDM())
					.then(dm => dm.send('New turn for ' + player.nation + ' in ' + game.name))
					.catch(console.log);
			}
		} else {
			let toSend = '';
			for (let player of toNotifyNewTurn) {
				toSend += '<@' + player.id + '>, ';
			}
			toSend += 'new turn';
			spamProtectedSend(channel, toSend);
		}
	}
}

function decay() {
	for (let game of gamesById.values()) {
		getLlamaString(game.name)
			.then(llamastring => {
				if (llamastring == undefined) {
					game.decayCounter++;
				} else {
					game.decayCounter = 0;
				}
				console.log('decayCounter: ' + game.decayCounter);

				if (game.decayCounter > config.decayThreshold) {
					gamesById.delete(game.channelId);
					console.log(game.name + ' has decayed.');
				}
				saveGames();
			})
			.catch(err => handleError(adminDM, err));
	}
}

//command functions
//-----------------
function help(msg) {
	msg.channel.send('Commands are:\n' +
		prefix + 'register <Llamaserver game>\n' +
		prefix + 'unregister\n' +
		prefix + 'claim <nation>\n' +
		prefix + 'unclaim\n' +
		prefix + 'assign <discord user> <nation>\n' +
		prefix + 'unassign <discord tag> OR unassign <nation>\n' +
		prefix + 'gamehost\n' +
		prefix + 'time\n' +
		prefix + 'undone\n' +
		prefix + 'silent\n' +
		prefix + 'disable\n' +
		prefix + 'enable');
}

function register(msg, args) {
	if (args.length == 0) {
		msg.channel.send(`Usage: ${prefix}register <name-of-Llamaserver-game>`);
		return;
	}
	if (gamesById.has(msg.channel.id)) {
		msg.channel.send('This channel already has a game registered. Use ' + prefix + 'unregister to remove it');
		return;
	}

	getLlamaString(args[0])
		.then(llamastring => {
			game = new Game(msg.channel.id, args[0]);
			gamesById.set(msg.channel.id, game);
			saveGames();
			msg.channel.send(`Game registered. Players can now ${prefix}claim`);
		})
		.catch(err => handleError(msg.channel, err));
}

function unregister(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	msg.channel.send('This will delete the game from the database. Are you sure? Use ' + prefix + 'confirm to proceed');
	client.setTimeout(msgAuthor => unregisterCommandsNotYetConfirmed.delete(msgAuthor), 1000*60*2, msg.author);
	unregisterCommandsNotYetConfirmed.set(msg.author, msg.channel);
}

function confirmUnregister(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	if (!(unregisterCommandsNotYetConfirmed.has(msg.author) && (unregisterCommandsNotYetConfirmed.get(msg.author) == msg.channel))) {
		msg.channel.send('Nothing to confirm. This command is to be used in conjunction with ' 
			+ prefix + 'unregister. Unconfirmed unregister requests decay after 2 minutes.');
		return;
	}

	gamesById.delete(msg.channel.id);
	msg.channel.send('Game deleted from database.');
	saveGames();
}

function claim(msg, args) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	if (args.length == 0) {
		msg.channel.send(`Usage: ${prefix}claim <nation>`);
		return;
	}

	let game = gamesById.get(msg.channel.id);
	if (game.playersById.has(msg.author.id)) {
		msg.channel.send('You already claimed a nation. Use ' + prefix + 'unclaim first if you want to switch');
		return;
	}
	getLlamaString(game.name)
		.then(llamastring => {
			let llData = new LlamaData(llamastring);
			let nationAsTypedByUser = args.shift();
			for (let arg of args) {
				nationAsTypedByUser += ' ' + arg;
			}
			let nationToClaim = matchInputToNation(nationAsTypedByUser, llData.isDoneByNation.keys());
			if (nationToClaim == undefined) {
				msg.channel.send('This nation is not in the game.');
				return;
			}

			let player = new Player(msg.author.id, nationToClaim);
			game.playersById.set(msg.author.id, player);
			saveGames();
			msg.channel.send(`You have claimed the nation ${nationToClaim}`);
		})
		.catch(err => handleError(msg.channel, err));
}

function unclaim(msg) {
		if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	let game = gamesById.get(msg.channel.id);
	if (!game.playersById.has(msg.author.id)) {
		msg.channel.send('You have not yet claimed a nation.');
		return;
	}

	msg.channel.send('You have unclaimed the nation ' + game.playersById.get(msg.author.id).nation);
	game.playersById.delete(msg.author.id);
	saveGames();
}

function fun_assign(msg, args) {
		if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	if (args.length < 2) {
		msg.channel.send('Usage: ' + prefix + 'assign <player tag> <nation>');
		return;
	}
	let mentions = msg.mentions.users;
	if (mentions.size != 1) {
		msg.channel.send('Usage: ' + prefix + 'assign <player tag> <nation>');
		return;
	}
	let userToAssign = mentions.first();
	let game = gamesById.get(msg.channel.id);
	if (game.playersById.has(userToAssign.id)) {
		msg.channel.send('This player already has been assigned the nation ' 
			+ game.playersById.get(userToAssign.id).nation + '. Use ' + prefix + 'unassign to remove');
		return;
	}

	getLlamaString(game.name)
		.then(llamastring => {
			let llData = new LlamaData(llamastring);
			let nationAsTypedByUser = '';
			for (arg of args) {
				if (arg.charAt(0) == '<@' && arg.endsWith('>')) {
					continue;
				} else {
					nationAsTypedByUser += arg + ' ';
				}
			}
			nationAsTypedByUser.trimEnd();
			let nation = matchInputToNation(nationAsTypedByUser, llData.isDoneByNation.keys());
			if (nation == undefined) {
				msg.channel.send('This nation is not in the game.');
				return;
			}

			let player = new Player(userToAssign.id, nation);
			game.playersById.set(player.id, player);
			saveGames();
			msg.channel.send(userToAssign + ' has been assigned the nation ' + nation);
		})
}

function unassign(msg, args) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	if (args.length!= 1) {
		msg.channel.send('Usage: ' + prefix + 'unassign <player tag> OR unassign <nation>');
		return;
	}

	let mentions = msg.mentions.users;
	let game = gamesById.get(msg.channel.id);
	if (mentions.size == 1) {//only 1 arg that is a mention
		let userToUnassign = mentions.first();
		if (!game.playersById.has(userToUnassign.id)) {
			msg.channel.send('That player is not assigned a nation currently');
			return;
		} else {
			msg.channel.send('Unassigned ' + game.playersById.get(userToUnassign.id).nation + '/' + userToUnassign);
			game.playersById.delete(userToUnassign.id);
			saveGames();
			return;
		}
	} else {//only 1 arg that is not a mention, so it should be a nation
		let nationToUnassign = matchInputToNation(args[0], game.getNations());
		if (nationToUnassign == undefined) {
			msg.channel.send('That nation is not in the game');
			return;
		} else {
			playerToUnassign = game.getPlayerByNation(nationToUnassign);
			if (playerToUnassign) {
				game.playersById.delete(game.getPlayerByNation(nationToUnassign));
				saveGames();
				msg.channel.send('Unassigned ' + playerToUnassign.nation + '/<@' + playerToUnassign.id + '>');
				return;
			} else {
				msg.channel.send('That nation is not assigned to a player');
				return;
			}
		}
	}
}

function who(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	let game = gamesById.get(msg.channel.id);
	let promisedPlayerUsers = [];
	for (let player of game.playersById.values()) {
		promisedPlayerUsers.push(client.fetchUser(player.id));
	}
	let playerListing = Promise.all(promisedPlayerUsers)
		.then(deliveredUsers => {
			let result = '';
			for (let user of deliveredUsers) {
				result += user.username + ' plays ' + game.playersById.get(user.id).nation + '\n';
			}
			if (result == '') result = 'Nobody has claimed a nation yet.\n';
			return result;
		})
		.catch(err => handleError(msg.channel, err));

	let promisedGamehostUsers = [];
	for (let gamehost of game.gamehosts) {
		promisedGamehostUsers.push(client.fetchUser(gamehost));
	}
	let gamehostListing = Promise.all(promisedGamehostUsers)
		.then(deliveredUsers => {
			if (deliveredUsers.length == 0) {
				return '';
			} else if (deliveredUsers.length == 1) {
				return deliveredUsers[0].username + ' is a gamehost';
			} else {
				let result = '';
				for (let user of deliveredUsers) {
					result += user.username + ', ';
				}
				result = result.slice(0, -2);
				result += ' are gamehosts';
				return result;
			}
		})
		.catch(err => handleError(msg.channel, err));

	Promise.all([playerListing, gamehostListing])
		.then(listings => {
			msg.channel.send(listings[0] + listings[1]);
		})
		.catch(err => handleError(msg.channel, err));
}

function undone(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	let game = gamesById.get(msg.channel.id);
	getLlamaString(game.name)
		.then(async llamastring => {
			let llData = new LlamaData(llamastring);
			let undoneString = '';
			let numUndoneNations = 0;
			for (let isDoneByNation of llData.isDoneByNation) {
				let isDone = isDoneByNation[1];
				let nation = isDoneByNation[0];
				if (!isDone) {
					undoneString += nation;
					numUndoneNations++;
					for (player of game.playersById.values()) {
						if (nation == player.nation) {
							let user = await client.fetchUser(player.id);
							undoneString += ' (' + user.username + ')';
						}
					}
					undoneString += ', ';
				}
			}
			undoneString = undoneString.substring(0, undoneString.length - 2);
			if (numUndoneNations == 1) {
				undoneString += ' has not done their turn yet';
			} else {
				undoneString += ' have not done their turns yet';
			}
			msg.channel.send(undoneString);
		})
	.catch(err => handleError(msg.channel, err));
}

function gamehost(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	let game = gamesById.get(msg.channel.id);
	if (!game.gamehosts.has(msg.author.id)) {
		game.gamehosts.add(msg.author.id);
		msg.channel.send('You are now a gamehost. You will receive notifications when another player is running out of time');
	} else {
		game.gamehosts.delete(msg.author.id);
		msg.channel.send('You are no longer a gamehost.');
	}
	saveGames();
}

function time(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	let game = gamesById.get(msg.channel.id);
	getLlamaString(game.name)
		.then(llamastring => {
			let llData = new LlamaData(llamastring);
			let days = Math.trunc(llData.minsLeft / (60*24));
			let hours = Math.trunc((llData.minsLeft - days*60*24) / 60);
			let mins = llData.minsLeft % 60;
			let toSend = 'There are ';
			if (days > 0) toSend += days + ' days ' + hours + ' hours ';
			else if (hours > 0) toSend += hours + ' hours ';
			toSend += mins + ' minutes left.'
			msg.channel.send(toSend);
		})
		.catch(err => handleError(msg.channel, err));
}

function silent(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	let game = gamesById.get(msg.channel.id);
	game.isSilentMode = !game.isSilentMode;
	if (game.isSilentMode) {
		msg.channel.send('Silent mode ON. Player notifications will be sent as direct messages');
	} else {
		msg.channel.send('Silent mode OFF');
	}
	saveGames();
}

function disable(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	let game = gamesById.get(msg.channel.id);
	if (!game.isEnabled) {
		msg.channel.send('Game is already disabled');
		return;
	}

	game.isEnabled = false;
	msg.channel.send('Game disabled. Notifications and error messages will not be sent. Use ' 
		+ prefix + 'enable to reverse');
	saveGames();	
}

function enable(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}
	let game = gamesById.get(msg.channel.id);
	if (game.isEnabled) {
		msg.channel.send('Game is already enabled');
		return;
	}

	game.isEnabled = true;
	game.spamProtectionTimestamps = [];
	msg.channel.send('Game enabled. Notifications and error messages will be sent');
	saveGames();
}

function broadcast(msg, args) {
	if (!msg.author.id == config.adminId) {
		msg.channel.send('Only <@' + config.adminId + '> can use this command');
		return;
	}
	if (args.length == 0) return;

	let stringToBroadcast = msg.content.substring(msg.content.indexOf(' ') + 1);
	for (let game of gamesById.values()) {
		let channel = client.channels.get(game.channelId);
		channel.send(stringToBroadcast)
	}
}	

function shutdown(msg) {
	if (!msg.author.id == config.adminId) {
		msg.channel.send('Only <@' + config.adminId + '> can use this command');
		return;
	}

	msg.channel.send('This will shut down the bot. Are you sure? Use ' + prefix + 'confirmshutdown with two minutes to proceed.');
	shutdownCommandsNotYetConfirmed.set(msg.author, msg);
	client.setTimeout(author => shutdownCommandsNotYetConfirmed.delete(author), 1000*60*2, msg.author);
}

function confirmShutdown(msg) {
	if (!msg.author.id == config.adminId) {
		msg.channel.send('Only <@' + config.adminId + '> can use this command');
		return;
	}
	if (!shutdownCommandsNotYetConfirmed.has(msg.author)) {
		msg.channel.send('Nothing to confirm. This command is to be used in conjunction with ' 	+ prefix + 'shutdown');
		return;
	}

	msg.channel.send('Shutting down.')
		.then(() => client.destroy())
		.catch(err => handleError(msg.channel, err));
}

//auxiliary functions
//-------------------
function handleError(channel, err) {//send something in Discord
	logError(err);
	console.error(gamesById);
	if (err.additionalInfo) {
		logError(err.additionalInfo);
	}
	logError(err.stack);
	spamProtectedSend(channel, 'Error: ' + err + '\n<@' + config.adminId + '> please take a look at this.');
}

function logError(errorString) {
	console.error(errorString);
	fs.appendFile('error.log', errorString + '\r\n', (err) => {
		if (err) throw err;
	});
}

function spamProtectedSend(channel, str) {
	let game = gamesById.get(channel.id);
	let now = Date.now();
	game.spamProtectionTimestamps.push(now);
	while (game.spamProtectionTimestamps[0] < now - 1000*60*config.spamProtectionTimeFrameInMinutes) {
		game.spamProtectionTimestamps.shift();
	}
	if (game.spamProtectionTimestamps.length >= config.spamProtectionMessageTreshold) {
		game.isEnabled = false;
		channel.send("I'm sending too many messages. <@" + config.adminId + '> please take a look at this.\n'
			+ 'Game disabled. Notifications and error messages will not be sent. Use ' + prefix + 'enable to reverse');
		saveGames();
	}	else {
		channel.send(str);
	}
}

function matchInputToNation(input, nations) {//will proceed to try matches of descending accuracy
	let nations2 = [];//Iterators for consumption, will be filled as another is consumed
	let nations3 = [];//This seems hacky.
	for (let nation of nations) {//exact match
		nations2.push(nation);
		nations3.push(nation);
		if (input == nation) {
			return nation;
		}
	}
	input = input.replace(/[^a-zA-Z]/g, "").toLowerCase();
	for (let nation of nations2) {//letters match
		if (input == nation.replace(/[^a-zA-Z]/g, "").toLowerCase()) {
			return nation;
		}
	}
	if (input.length > 0) {
		for (let nation of nations3) {//first letters match
			if (input == nation.replace(/[^a-zA-Z]/g, "").toLowerCase().substring(0, input.length)) {
				return nation;
			}
		}
	}
	return undefined;
}

function getStalerString(name) {
	let url = 'http://www.llamaserver.net/doAdminAction.cgi?game=' + name + '&action=showstales';
	let request = snekfetch.get(url);
	return new Promise((resolve, reject) => request.on('data', data => {
		let rawString = data.toString();
		if (rawString.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
			reject('This game does not exist');
		}	else {
			let chunks = rawString.split('<tr>');
			chunks.shift();
			chunks.shift();
			let returnString = '';
			for (let chunk of chunks) {
				let snippets = chunk.split('&nbsp');
				if (snippets[snippets.length - 2] === ';Staled') {
					returnString += snippets[1].trim().substr(1) + ', ';
				}
			}
			if (returnString.length > 0) {
				returnString = returnString.substr(0, returnString.length - 2);
				returnString += ' staled';
			}
			resolve(returnString);
		}
	}));
}

function gamesToString(games) {
	let str = '';
	for (let game of games.values()) {
		str += game.channelId + '#' + game.name + '#' + game.decayCounter + '#';
		if (game.isEnabled) str += 'T';
		else str += 'F';
		if (game.isSilentMode) str += 'T';
		else str += 'F';
		if (game.isNotifiedNewTurn) str += 'T';
		else str += 'F';
		if (game.isNotified) str += 'T';
		else str += 'F';
		if (game.isNotifiedUrgent) str += 'T';
		else str += 'F';
		if (game.isNotifiedLast) str += 'T';
		else str += 'F';

		let gamehostsString = '#';
		if (game.gamehosts.size > 0) {
			for (gamehostId of game.gamehosts) {
				gamehostsString += gamehostId + ':';
			}
			gamehostsString = gamehostsString.substr(0, gamehostsString.length - 1);
		}
		str += gamehostsString;

		let playersString = '#';
		if (game.playersById.size > 0) {
			for (let player of game.playersById.values()) {
				playersString += player.id + '@' + player.nation + ':';
			}
			playersString = playersString.substr(0, playersString.length - 1);
		}
		str += playersString + '\n';
	}
	return str;
}

function gamesFromString(str) {
	let games = new Map();
	let gameStrings = str.split('\n');
	gameStrings.pop();
	for (let gameString of gameStrings) {
		let chunks = gameString.split('#');
		let channelId = chunks.shift();
		let gameName = chunks.shift();
		let game = new Game(channelId, gameName);
		game.decayCounter = parseInt(chunks.shift());

		let flags = chunks.shift().split('');
		game.isEnabled = (flags[0] === 'T');
		game.isSilentMode = (flags[1] === 'T');
		game.isNotifiedNewTurn = (flags[2] === 'T');
		game.isNotified = (flags[3] === 'T');
		game.isNotifiedUrgent = (flags[4] === 'T');
		game.isNotifiedLast = (flags[5] === 'T');

		let gamehosts = chunks.shift().split(':');
		for (let gamehost of gamehosts) {
			if (!gamehost == '') {
				game.gamehosts.add(gamehost);
			}
		}
		for (let playersString of chunks.shift().split(':')) {
			let playerData = playersString.split('@');
			let player = new Player(playerData[0], playerData[1]);
			game.playersById.set(playerData[0], player);
		}

		games.set(channelId, game);
	}
	return games;
}

function saveGames() {
	let stringToSave = gamesToString(gamesById);
	console.log('Saving: ' + stringToSave);
	fs.writeFile('games.dat', stringToSave, function (err) {
		if (err) throw err;
	});
}

function getLlamaString(name) {
	console.log('Fetching LlamaString for game: ' + name);
	let url = 'http://www.llamaserver.net/gameinfo.cgi?game=' + name;
	let request = snekfetch.get(url);
	return new Promise((resolve, reject) => request.on('data', data => {
		let llamastring = data.toString();
		if (llamastring.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
			resolve(undefined);
		}
		if (llamastring.includes('This game has not shown any activity for some time')) {
			resolve(undefined);
		}
		if (llamastring.includes('Game status</title>')) {
			resolve(llamastring);
		}
		//else
		reject('llamastring: ' + llamastring);
	}));
}

//Constructors
//------------
function LlamaData(inputStr) {
	try {
		let str = inputStr;
		let currentYear = new Date().getFullYear();
		let months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

		str = str.substring(str.indexOf('Turn number'));
		let current = str.substring(str.indexOf('Last updated at ') + 16, str.indexOf('<a align="right" href="https://pledgie.com'));
		current = current.split(' ');
		let timeOfDay = current[0];
		let cMonth = months.indexOf(current[4]);
		let cDay = parseInt(current[5].slice(0,-2));
		let cHours = parseInt(timeOfDay.substring(0, 2));
		let cMinutes = parseInt(timeOfDay.substring(3, 5));
		current = new Date(currentYear, cMonth, cDay, cHours, cMinutes);

		let due = str.substring(str.indexOf('Next turn due:') + 15, str.indexOf('<br><br><TABLE'));
		due = due.split(' ');
		timeOfDay = due[0];
		let dueMonth = months.indexOf(due[4]);
		let dueDay = parseInt(due[5].slice(0,-2));
		let dueHours = parseInt(timeOfDay.substring(0, 2));
		let dueMinutes = parseInt(timeOfDay.substring(3, 5));
		due = new Date(currentYear, dueMonth, dueDay, dueHours, dueMinutes);
		if (current > due) due.setFullYear(due.getFullYear() + 1);

		this.minsLeft = (due - current) / (1000*60);

		let isDoneByNation = new Map();
		let llamaTableRows = str.split('<tr><td>');
		llamaTableRows.shift();
		for (let row of llamaTableRows) {
			let nation = row.slice(0, row.indexOf('</td><td>')).trim();
			let isDone = row.slice(57,73);
			isDone = (isDone === '2h file received') ? true : false;
			isDoneByNation.set(nation, isDone);
		}
		this.isDoneByNation = isDoneByNation;
	} catch(err) {
		if (err.message == 'Cannot read property \'slice\' of undefined') {
			this.isMalformed = true;
			return;
		}

		err.additionalInfo = inputStr;
		throw err;
	}
}

function Game(channelId, name) {
	this.channelId = channelId;
	this.name = name;
	this.isEnabled = true;
	this.isSilentMode = false;
	this.playersById = new Map();
	this.gamehosts = new Set();
	this.isNotifiedNewTurn = false;
	this.isNotified = false;
	this.isNotifiedUrgent = false;
	this.isNotifiedLast = false;
	this.decayCounter = 0;
	this.spamProtectionTimestamps = [];

	this.getNations = function() {
		let nations = new Set();
		for (let player of this.playersById.values()) {
			nations.add(player.nation);
		}
		return nations;
	}

	this.getPlayerByNation = function(nation) {
		for (let player of this.playersById.values()) {
			if (player.nation == nation) return player;
		}
		return false;
	};
}

function Player(id, nation) {
	this.id = id;              
	this.nation = nation;
}
