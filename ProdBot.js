const Discord = require('discord.js');
const client = new Discord.Client();
const auth = require('./auth.json');
const fs = require('fs');
const fetch = require('node-fetch');
const config = require('./config.json');
const prefix = config.commandPrefix;
const colors = require('colors');

let gamesById = new Map();
let unregisterCommandsNotYetConfirmed = new Map();
let shutdownCommandsNotYetConfirmed = new Map();
let adminDM;//has an added .game property to handle spam protection
let tickCounter = -1;//serves to only evaluate certain games after a set number of ticks
let noDateInHtmlErrorCounter = 0;
let otherErrorCounter = 0;
let deletionTimeout = config.messageDeletionTimerInMinutes;

//client behavior
//---------------
console.log('attempting Discord login...');
client.login(auth.token);

client.on('ready', () => {
	let str = 'logged in as ' + client.user.tag + '!';
	console.log(str.green);
	//load games from file
	if (!fs.existsSync('games.dat')) {
		console.log('games.dat not found, generating empty games.dat');
		saveGames();
	} else {
		console.log('reading games.dat');
		fs.readFile('games.dat', 'utf8', (err, data) => {
			if (err) throw err;
			gamesById = gamesFromString(data);
			console.log({gamesById});
		});
	}
	//create admin dm channel for error messages
	client.users.fetch(config.adminId)
		.then(adminUser => adminUser.createDM())
		.then(DM =>	{
			adminDM = DM;
			adminDM.game = new Game(adminDM.id, undefined);//Game.channelId and Game.spamProtectionTimeStamps will be used
		})																							 //in spam protection
		.catch(err => {
			console.error('Error fetching adminDM');
			console.error(err);
			process.exit(1);
		});

	console.log('starting core loop');
	client.setInterval(tick, 1000 * config.tickInSeconds);
	client.setInterval(decay, 1000*60*60*24);
	client.setInterval(dailyReport, 1000*60*60*24);
});

client.on('message', msg => {
	try {
		if (msg.author.bot) return;

		if (msg.channel.type == 'dm') {
			if (msg.channel == adminDM) {
				if (msg.content.startsWith(prefix + 'enable')) {
					if (!adminDM.game.isEnabled) {
						adminDM.game.spamProtectionTimestamps = [];
						adminDM.game.isEnabled = true;
						adminDM.send('I enabled you');
					} else {
						adminDM.send('Already enabled');
					}
				} else if (msg.content.startsWith(prefix + 'showgames')) {
					for (let game of gamesById.values()) {
						msg.channel.send(JSON.stringify(game));
					}
					msg.channel.send('htmlRequestQueue.queue.length = ' + htmlRequestQueue.queue.length);
				}
			} else {
				msg.channel.send('Bot commands do not work in direct message. Go to a channel to get access to bot commands');
				help(msg);
			}
			return;
		}

		if (msg.channel.type != 'text' && msg.channel.type != 'voice') return;

		//process commands
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
		handleError(err, msg.channel);
	}
});

//core loop and associated functions, also game decay
//---------------------------------------------------
function tick() {
	try {
		tickCounter++;
		if (tickCounter >= config.numTicksToProcessAllGames) tickCounter = 0;
		console.log('tick: '.green + tickCounter.toString().green);

		let queueLengthTreshold = gamesById.size * config.queueEntriesPerGameWarningThreshold;
		if (htmlRequestQueue.queue.length > queueLengthTreshold) spamProtectedSend(adminDM, 'queueLengthTreshold exceeded');

		let allGamesProcessing = [];
		for (let game of gamesById.values()) {
			if (!game.isEnabled) continue;
			if (tickCounter != 0 && !game.isCloseToNewTurn) continue;

			let gameProcessing = getLlamaData(game.name)
				.then(llamaData => {
					if (llamaData == 'game does not exist') {
						/*game.getChannel() TODO replace bandaid with something more substantial
						.then(channel => channel.send('It seems like this Llamaserver game does not exist anymore. I disable it ' +
							'for now. Either use ' + prefix + 'unregister to delete it, or leave it to decay in about three weeks.'));
						game.isEnabled = false;*/
					} else {
						game.isCloseToNewTurn = (llamaData.minsLeft < config.timerLong * 2);
						removeDroppedPlayers(game, llamaData);
						notifyLate(game, llamaData, config.timerLong, false);
						notifyLate(game, llamaData, config.timerShort, true);
						notifyLast(game, llamaData);
						checkNewTurn(game, llamaData);
					}
				})
				.catch(err => {
					handleError(err, game.getChannel());
				});
			allGamesProcessing.push(gameProcessing);
		}
		Promise.all(allGamesProcessing).then(saveGames).catch(err => handleError(err));
	} catch(err) {
		handleError(err);
	}
}

function llamaNotFound(game) {
	game.isDormant = true;
	game.getChannel()
		.then(channel => channel.send('Could not find Llamaserver page for the game...'));
}

function removeDroppedPlayers(game, llamaData) {
	for (let player of game.playersById.values()) {
		if (!llamaData.isDoneByNation.has(player.nation)) {
			game.playersById.delete(player.id);
		}
	}
}

async function notifyLate(game, llamaData, timer, isUrgent) {
	try {
		//reset flags and return if appropriate
		if (llamaData.minsLeft > timer) {
			if (isUrgent) {
				game.isNotifiedUrgent = false;
			} else {
				game.isNotified = false;
			}
			return;
		}
		//otherwise, do the notification thing
		let isNotified = isUrgent ? game.isNotifiedUrgent : game.isNotified;
		if (!isNotified && Array.from(llamaData.isDoneByNation.values()).includes(false)) {
			//determine who needs to be notified
			let gamehostIdsToNotify = game.gamehosts;
			let playerIdsToNotify = new Set();
			let unclaimedNations = new Set();//llamaData.isDoneByNation.keys());//will remove the claimed nations in the following for loop
			for (let entry of llamaData.isDoneByNation) {//TODO this is a slightly hacky bandaid
				if (entry[1] == false) unclaimedNations.add(entry[0]);
			}
			for (let player of game.playersById.values()) {
				if (llamaData.isDoneByNation.get(player.nation) === false) {
					playerIdsToNotify.add(player.id);
					gamehostIdsToNotify.delete(player.id);//no need to notify the person twice
				}
				unclaimedNations.delete(player.nation);
			}
			//send out notifications
			if (game.isSilentMode) {
				for (let playerId of playerIdsToNotify) {
					let user = await client.users.fetch(playerId);
					let dm = await user.createDM();
					dm.send('' + llamaData.minsLeft + ' minutes left in ' + game.name);
				}
				for (let gamehostId of gamehostIdsToNotify) {
					client.users.fetch(gamehostId)
						.then(user => user.createDM())
						.then(dm => dm.send('' + llamaData.minsLeft + ' minutes left in ' + game.name))
						.catch(err => handleError(err, adminDM));
				}
			} else {
				let channel = await game.getChannel();
				let notificationString = '';
				for (id of playerIdsToNotify) {
					notificationString += '<@' + id + '>, ';
				}
				for (nation of unclaimedNations) {
					notificationString += nation + ', ';
				}
				notificationString += llamaData.minsLeft + ' minutes to do your turn';
				if (isUrgent) notificationString += '!';
				for (id of gamehostIdsToNotify) {
					notificationString += ' <@' + id + '>';
				}
				spamProtectedSend(channel, notificationString)
				.then(botReply => botReply.delete(new DeletionTimeout(timer)));
			}
			//update game flags
			if (isUrgent) {
				game.isNotifiedUrgent = true;
			} else {
				game.isNotified = true;
			}
		}
	} catch (err) {
		handleError(err, game.getChannel());
	}
}

function notifyLast(game, llamaData) {
	let numNationsNotDone = 0;
	let lastNation;
	for (let entry of llamaData.isDoneByNation) {
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
			if (game.isSilentMode) {
				client.users.fetch(lastPlayer.id)
					.then(user => user.createDM())
					.then(dm => dm.send('Last undone turn in ' + game.name))
					.catch(err => handleError(err));
			} else {
				game.getChannel()
					.then(channel => spamProtectedSend(channel, '<@' + lastPlayer.id + '> last'));
			}
			game.isNotifiedLast = true;
		}
	}
}

async function checkNewTurn(game, llamaData) {
	try {
		let someoneHasDoneTheirTurn = false;
		for (let turnDone of llamaData.isDoneByNation.values()) {
			if (turnDone) someoneHasDoneTheirTurn = true;
		}	
		if (someoneHasDoneTheirTurn) {
			game.isNotifiedNewTurn = false;
			return;
		}	

		if (!someoneHasDoneTheirTurn && !game.isNotifiedNewTurn) {
			let channel = await game.getChannel();

			//send out staling information
			getStalerString(game.name)
				.then(stalerString => {
					if (stalerString) channel.send(stalerString);
				})
				.catch(err => {
					handleError(err, game.getChannel());
				});

			game.isNotifiedNewTurn = true;
			let toNotifyNewTurn = new Set();
			for (let player of game.playersById.values()) {
				toNotifyNewTurn.add(player);
			}
			//if (toNotifyNewTurn.size == 0) return; 

			//send out notification
			if (game.isSilentMode) {
				adminDM.send(game.name);
				for (let player of toNotifyNewTurn) {
					client.users.fetch(player.id)
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
	} catch (err) {
		handleError(err, game.getChannel());
	}
}

function decay() {
	for (let game of gamesById.values()) {
		getLlamaString(game.name)
			.then(llamaString => {
				if (llamaString.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
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
			.catch(err => handleError(err));
	}
}

function dailyReport() {
	if (noDateInHtmlErrorCounter > 0) {
		adminDM.send('noDateInHtmlErrorCounter: ' + noDateInHtmlErrorCounter);
	}
	noDateInHtmlErrorCounter = 0;
	if (otherErrorCounter > 0) {
		adminDM.send('otherErrorCounter: ' + otherErrorCounter);
	}
	otherErrorCounter = 0;
}

//command functions
//-----------------
function help(msg) {
	msg.channel.send('Commands are:\n' +
		prefix + 'register <Llamaserver game>\n' +
		prefix + 'unregister\n' +
		prefix + 'claim <nation>\n' +
		prefix + 'unclaim\n' +
		prefix + 'assign <discord tag> OR <nation>\n' +
		prefix + 'unassign <discord tag> OR <nation>\n' +
		prefix + 'who\n' +
		prefix + 'undone\n' +
		prefix + 'time\n' +
		prefix + 'gamehost\n' +
		prefix + 'silent\n' +
		prefix + 'disable\n' +
		prefix + 'enable\n' +
		'use ' + prefix + 'register to get started');
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

	getLlamaString(args[0], true)
		.then(llamaString => {
			game = new Game(msg.channel.id, args[0]);
			gamesById.set(msg.channel.id, game);
			saveGames();
			msg.channel.send(`Game registered. Players can now ${prefix}claim, or you can ${prefix}assign`);
		})
		.catch(err => handleError(err, msg.channel));
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

async function claim(msg, args) {
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
	llamaString = await getLlamaString(game.name, true);
	let llamaData = new LlamaData(llamaString);
	if (llamaData = 'game does not exist') {
		msg.channel.send('This game does not exist on Llamaserver');
		return;
	}
	if (llamaData = 'no data') {
		msg.channel.send('Could not parse game page from Lamaserver');
		return;
	}
	let nationAsTypedByUser = args.shift();
	for (let arg of args) {
		nationAsTypedByUser += ' ' + arg;
	}
	let nationToClaim = matchInputToNation(nationAsTypedByUser, llamaData.isDoneByNation.keys());
	if (nationToClaim == undefined) {
		msg.channel.send('This nation is not in the game.');
		return;
	}

	let player = new Player(msg.author.id, nationToClaim);
	game.playersById.set(msg.author.id, player);
	saveGames();
	msg.channel.send(`You have claimed the nation ${nationToClaim}`);
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

	getLlamaString(game.name, true)
		.then(llamaString => {
			let llamaData = new LlamaData(llamaString);
			let nationAsTypedByUser = '';
			for (arg of args) {
				if (arg.charAt(0) == '<@' && arg.endsWith('>')) {
					continue;
				} else {
					nationAsTypedByUser += arg + ' ';
				}
			}
			nationAsTypedByUser.trimEnd();
			let nation = matchInputToNation(nationAsTypedByUser, llamaData.isDoneByNation.keys());
			if (nation == undefined) {
				msg.channel.send('This nation is not in the game.');
				return;
			}

			let player = new Player(userToAssign.id, nation);
			game.playersById.set(player.id, player);
			saveGames();
			msg.channel.send(userToAssign.toString() + ' has been assigned the nation ' + nation);
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
			msg.channel.send('Unassigned ' + game.playersById.get(userToUnassign.id).nation + '/' + userToUnassign.toString());
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
				msg.channel.send('Unassigned ' + playerToUnassign.nation + ', <@' + playerToUnassign.id + '>');
				return;
			} else {
				msg.channel.send('That nation is not assigned to a player');
				return;
			}
		}
	}
}

async function who(msg) {
	try {
		if (!gamesById.has(msg.channel.id)) {
			msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
			return;
		}

		let game = gamesById.get(msg.channel.id);
		let llamaString = await getLlamaString(game.name, true);
		let	nations = Array.from(new LlamaData(llamaString).isDoneByNation.keys());
		let promisedUsers = new Array(nations.length);//will be possibly sparse, indices lined up with array nations,
		//gamehosts added at the end. All set for Promises.all
		for (let player of game.playersById.values()) {
			let index = nations.indexOf(player.nation);
			promisedUsers[index] = client.users.fetch(player.id);
		}
		for (let gamehost of game.gamehosts) {
			promisedUsers.push(client.users.fetch(gamehost));
		}
		let users = await Promise.all(promisedUsers);

		let returnString = '';
		for (let nation of nations) {
			returnString += nation;
			let user = users.shift();
			if (user) {
				returnString += ': ' + user.username;
			}
			returnString += ', ';
		}
		returnString = returnString.substring(0, returnString.length - 2);

		if (users.length > 0) {//still gamehosts left
			let isSingleGamehost = (users.length == 1);
			returnString += '\n';
			for (let user of users) {
				returnString +=	user.toString() + ', ';
			}
			returnString = returnString.substring(0, returnString.length - 2);

			if (isSingleGamehost) returnString += ' is gamehost and will be notified when a player runs late';
			else returnString += ' are gamehosts and will be notified when a player runs late';
		}
		msg.channel.send(returnString);
	} catch (err) {
		handleError(err, msg.channel);
	}
}

function undone(msg) {
	if (!gamesById.has(msg.channel.id)) {
		msg.channel.send('Game is not registered. Use ' + prefix + 'register or ' + prefix + 'help');
		return;
	}

	let game = gamesById.get(msg.channel.id);
	getLlamaString(game.name, true)
		.then(async llamaString => {
			let llamaData = new LlamaData(llamaString);
			let undoneString = '';
			let numUndoneNations = 0;
			for (let isDoneByNation of llamaData.isDoneByNation) {
				let isDone = isDoneByNation[1];
				let nation = isDoneByNation[0];
				if (!isDone) {
					undoneString += nation;
					numUndoneNations++;
					for (player of game.playersById.values()) {
						if (nation == player.nation) {
							let user = await client.users.fetch(player.id);
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
			msg.channel.send(undoneString)
			.then(botReply => botReply.delete(new DeletionTimeout(deletionTimeout)));
			msg.delete(new DeletionTimeout(deletionTimeout));
		})
		.catch(err => handleError(err, msg.channel));
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
	getLlamaString(game.name, true)
		.then(llamaString => {
			let llamaData = new LlamaData(llamaString);
			let days = Math.trunc(llamaData.minsLeft / (60*24));
			let hours = Math.trunc((llamaData.minsLeft - days*60*24) / 60);
			let mins = llamaData.minsLeft % 60;
			let toSend = 'There are ';
			if (days > 0) toSend += days + ' days ' + hours + ' hours ';
			else if (hours > 0) toSend += hours + ' hours ';
			toSend += mins + ' minutes left.'
			msg.channel.send(toSend)
			.then(botReply => botReply.delete(new DeletionTimeout(deletionTimeout)));
			msg.delete(new DeletionTimeout(deletionTimeout));

		})
		.catch(err => handleError(err, msg.channel));
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
	adminDM.send(msg.content);
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

async function broadcast(msg, args) {
	if (!msg.author.id == config.adminId) {
		msg.channel.send('Only <@' + config.adminId + '> can use this command');
		return;
	}
	if (args.length == 0) return;

	let stringToBroadcast = msg.content.substring(msg.content.indexOf(' ') + 1);
	for (let game of gamesById.values()) {
		let channel = await game.getChannel();
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
		.catch(err => handleError(err, msg.channel));
}

//html request processing
//-----------------------
async function getLlamaData(name, isUrgent = false, numTries = 0) {
	let llamaString = await getLlamaString(name, isUrgent);
	if (llamaString.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
		return 'game does not exist';
	}
	let llamaData = new LlamaData(llamaString);
	if (!llamaData.isWellFormed()) {
		if (numTries < 10) {
			return getLlamaData(name, true, numTries + 1);
		} else {
			return 'no data';
		}
	} else {
		return llamaData;
	}
}

async function getLlamaString(name, isUrgent = false) {
	let url = 'http://www.llamaserver.net/gameinfo.cgi?game=' + name;
	return new Promise((resolve, reject) => {
		htmlRequestQueue.addToken({url, resolve, reject}, isUrgent);
	});
}

let htmlRequestQueue = {
	queue : [],
	isProcessing : false,

	addToken : function(token, isUrgent) {
		try {
			isUrgent ? htmlRequestQueue.queue.unshift(token) : htmlRequestQueue.queue.push(token);
			if (!htmlRequestQueue.isProcessing) {
				htmlRequestQueue.isProcessing = true;
				htmlRequestQueue.processNext();
			}
		} catch (err) {
			handleError(err);
		}
	},

	processNext : async function() {
		try {
			if (htmlRequestQueue.queue.length == 0) {//queue is emtpy, stop processing
				htmlRequestQueue.isProcessing = false;
			} else {
				let token = htmlRequestQueue.queue.shift();
				try {
					console.log('Fetching llamaString from ' + token.url);
					let response = await fetch(token.url);
					let text = await response.text();
					token.resolve(text);
				} catch (err) {
					token.reject(err);
				} finally {
					setTimeout(htmlRequestQueue.processNext, config.llamaserverHttpRequestDelay);
				}
			}
		} catch (err) {
			handleError(err);
		}
	}
}

//error handling
//--------------
async function handleError(err, channel = adminDM) {
	try {
		otherErrorCounter += 1;
		console.error('============================================================='.brightRed);
		console.error(err);
		console.error({gamesById});
		console.error('-------------------------------------------------------------'.brightRed);

		let errorLogText = new Date().toUTCString() + ':\r\n';
		errorLogText += err.stack + '\r\n';
		fs.appendFile('error.log', errorLogText, (err2) => {
			if (err2) throw err2;
		});

		try {
			channel = await channel;
		} catch (err3) {
			console.log(err3.name, err3.message, err3);
			if (err3 == 'timeout') {
				spamProtectedSend(adminDM, 'getChannel timeout:\nError: ' + err.message + '\n<@' + config.adminId + '> please take a look at this.');
				return;
			} else {
				throw err3;
			}
		}
		spamProtectedSend(channel, 'Error: ' + err.message + '\n<@' + config.adminId + '> please take a look at this.');

	} catch (err) {
		console.error('Error during handleError:');
		console.error(err);
		process.exit(1);
	}
}

//auxiliary functions
//-------------------
async function spamProtectedSend(channel, str) {
	try {
		console.log({channel});
		let game;
		if (channel == adminDM) {
			console.log('isAdmin');
			game = adminDM.game;
		} else {
			game = gamesById.get(channel.id);
			console.log({game});
		}
		if (!game.isEnabled) return;

		let now = Date.now();
		game.spamProtectionTimestamps.push(now);
		while (game.spamProtectionTimestamps[0] < now - 1000*60*config.spamProtectionTimeFrameInMinutes) {//clear outdated timestamps
			game.spamProtectionTimestamps.shift();
		}
		if (game.spamProtectionTimestamps.length >= config.spamProtectionMessageTreshold) {//too many recent timestamps
			game.isEnabled = false;
			channel.send("I'm sending too many messages. <@" + config.adminId + '> please take a look at this.\n'
				+ 'Game disabled. Notifications and error messages will not be sent. Use ' + prefix + 'enable to reverse');
			saveGames();
		}	else {
			return channel.send(str);
		}
	} catch (err) {
		handleError(err);
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
	console.log('Saving:\n' + stringToSave);
	fs.writeFile('games.dat', stringToSave, function (err) {
		if (err) throw err;
	});
}

async function getStalerString(name) {//error handling is done when calling this function because then the game channel is known
	let url = 'http://www.llamaserver.net/doAdminAction.cgi?game=' + name + '&action=showstales';
	let response = await fetch(url);
	let llamaStalerString = await response.text();
	if (llamaStalerString.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
		return '';
	}

	let chunks = llamaStalerString.split('<tr>');
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
	return returnString;
}

//Constructors
//------------
function LlamaData(llamaString) {
	this.isWellFormed = function() {
		if (typeof this.minsLeft != 'number') return false;
		if (this.isDoneByNation.size == 0) return false;

		return true;
	}

	try {
		let currentYear = new Date().getFullYear();
		let months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

		let current = llamaString.slice(llamaString.indexOf('Last updated at') + 16);
		current = current.slice(0, current.indexOf('<a align='));
		current = current.split(' ');
		if (current == '') throw new TypeError('LlamaData: cHours is not a number');//happens when llamaserver gets
		let cHours = parseInt(current[0].split(':')[0]);													 //too many requests...?
		let cMinutes = parseInt(current[0].split(':')[1]);                        
		let cDay = parseInt(current[5].slice(0,-2));
		let cMonth = months.indexOf(current[4]);
		current = new Date(currentYear, cMonth, cDay, cHours, cMinutes);

		let due = llamaString.slice(llamaString.indexOf('Next turn due:') + 15);
		due = due.slice(0, due.indexOf('<br><br>') - 1);
		due = due.split(' ');
		let dHours = parseInt(due[0].split(':')[0]);
		let dMinutes = parseInt(due[0].split(':')[1]);
		let dDay = parseInt(due[5].slice(0,-2));
		let dMonth = months.indexOf(due[4]);
		due	= new Date(currentYear, dMonth, dDay, dHours, dMinutes);

		if (current > due) due.setFullYear(due.getFullYear() + 1);

		this.minsLeft = (due - current) / (1000*60);
		let isDoneByNation = new Map();
		let llamaTableRows = llamaString.split('<tr><td>');
		llamaTableRows.shift();
		for (let row of llamaTableRows) {
			let nation = row.slice(0, row.indexOf('</td><td>')).trim();
			let isDone = row.slice(57,73);
			isDone = (isDone === '2h file received') ? true : false;
			isDoneByNation.set(nation, isDone);
		}
		this.isDoneByNation = isDoneByNation;
	} catch (err) {
		if (err.message == 'LlamaData: cHours is not a number') {
			noDateInHtmlErrorCounter += 1;
		} else {
			throw err;
		}
	}
}

function Game(channelId, name) {
	this.channelId = channelId;
	this.name = name;
	this.playersById = new Map();
	this.gamehosts = new Set();
	this.isEnabled = true;
	this.isDormant = false;
	this.isSilentMode = false;
	this.isNotifiedNewTurn = false;
	this.isNotified = false;
	this.isNotifiedUrgent = false;
	this.isNotifiedLast = false;
	this.decayCounter = 0;
	this.spamProtectionTimestamps = [];
	this.isCloseToNewTurn = true;

	this.getNations = function() {
		let nations = new Set();
		for (let player of this.playersById.values()) {
			nations.add(player.nation);
		}
		return nations;
	};

	this.getPlayerByNation = function(nation) {
		for (let player of this.playersById.values()) {
			if (player.nation == nation) return player;
		}
		return false;
	};

	this.getChannel = async function() {
		return new Promise(async (resolve, reject) => {
			setTimeout(reject, 3000, 'timeout');
			let channel =  await client.channels.fetch(this.channelId);
			resolve(channel);
		});
	};
}

function Player(id, nation) {
	this.id = id;              
	this.nation = nation;
}

function DeletionTimeout(time) {
	this.timeout = time * 60 * 1000;
}
