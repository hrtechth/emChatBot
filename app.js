'use strict';

const dialogflow = require('dialogflow');
const config = require('./config');
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const request = require('request');
const pg = require('pg');
const app = express();
const uuid = require('uuid');
const line = require('@line/bot-sdk');
var dateFormat = require('dateformat');
var util = require('util')

dateFormat.i18n = {
    dayNames: [
        'อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.',
        'อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'
 ],
    monthNames: [
        'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
        'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ],
    timeNames: [
        'a', 'p', 'am', 'pm', 'A', 'P', 'AM', 'PM'
    ]
};

const lineConfig = {
    channelAccessToken: config.LINE_CONFIG.channelAccessToken,
    channelSecret: config.LINE_CONFIG.channelSecret
};

const lineClient = new line.Client(lineConfig);

pg.defaults.ssl = true;

const webviews = require('./routes/webviews');


// Messenger API parameters
if (!config.FB_PAGE_TOKEN) {
    throw new Error('missing FB_PAGE_TOKEN');
}
if (!config.FB_VERIFY_TOKEN) {
    throw new Error('missing FB_VERIFY_TOKEN');
}
if (!config.GOOGLE_PROJECT_ID) {
    throw new Error('missing GOOGLE_PROJECT_ID');
}
if (!config.DF_LANGUAGE_CODE) {
    throw new Error('missing DF_LANGUAGE_CODE');
}
if (!config.GOOGLE_CLIENT_EMAIL) {
    throw new Error('missing GOOGLE_CLIENT_EMAIL');
}
if (!config.GOOGLE_PRIVATE_KEY) {
    throw new Error('missing GOOGLE_PRIVATE_KEY');
}
if (!config.FB_APP_SECRET) {
    throw new Error('missing FB_APP_SECRET');
}
if (!config.SERVER_URL) { //used for ink to static files
    throw new Error('missing SERVER_URL');
}
if (!config.PG_CONFIG) { //Postgresql Config Object
    throw new Error('missing PG_CONFIG');
}


app.set('view engine', 'ejs');
app.set('port', (process.env.PORT || 5000))

app.post('/callback/', line.middleware(lineConfig), (req, res) => {

    var data = req.body;
    console.log("Request: " + util.inspect(data)); 

    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result));
});

app.post('/webhookKK/', (req, res) => {
    //var data = req.body;
    //console.log("Request: "  + util.inspect(data)) 
});

//verify request came from facebook
app.use(bodyParser.json({
    verify: verifyRequestSignature
}));

//serve static files in the public directory
app.use(express.static('public'));

// Process application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({
    extended: false
}));

// Process application/json
app.use(bodyParser.json());
app.use('/webviews', webviews);

const credentials = {
    client_email: config.GOOGLE_CLIENT_EMAIL,
    private_key: config.GOOGLE_PRIVATE_KEY,
};

const sessionClient = new dialogflow.SessionsClient(
    {
        projectId: config.GOOGLE_PROJECT_ID,
        credentials
    }
);


const sessionIds = new Map();

// Index route
app.get('/', function (req, res) {
    res.send('Hello world, I am a chat bot')
})

// for Facebook verification
app.get('/webhook/', function (req, res) {
    console.log("request");
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.FB_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.error("Failed validation. Make sure the validation tokens match.");
        res.sendStatus(403);
    }
})

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook/', function (req, res) {
    var data = req.body;
    console.log("Request: " + JSON.stringify(data)); 

    // Make sure this is a page subscription
    if (data.object == 'page') {
        // Iterate over each entry
        // There may be multiple if batched
        data.entry.forEach(function (pageEntry) {
            var pageID = pageEntry.id;
            var timeOfEvent = pageEntry.time;

            // Iterate over each messaging event
            pageEntry.messaging.forEach(function (messagingEvent) {
                if (messagingEvent.optin) {
                    receivedAuthentication(messagingEvent);
                } else if (messagingEvent.message) {
                    receivedMessage(messagingEvent);
                } else if (messagingEvent.delivery) {
                    receivedDeliveryConfirmation(messagingEvent);
                } else if (messagingEvent.postback) {
                    receivedPostback(messagingEvent);
                } else if (messagingEvent.read) {
                    receivedMessageRead(messagingEvent);
                } else if (messagingEvent.account_linking) {
                    receivedAccountLink(messagingEvent);
                } else {
                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                }
            });
        });

        // Assume all went well.
        // You must send back a 200, within 20 seconds
        res.sendStatus(200);
    }
});

function receivedMessage(event) {

    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfMessage = event.timestamp;
    var message = event.message;

    if (!sessionIds.has(senderID)) {
        sessionIds.set(senderID, uuid.v1());
    }
    console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
    console.log(JSON.stringify(message));

    var isEcho = message.is_echo;
    var messageId = message.mid;
    var appId = message.app_id;
    var metadata = message.metadata;

    // You may get a text or attachment but not both
    var messageText = message.text;
    var messageAttachments = message.attachments;
    var quickReply = message.quick_reply;

    if (isEcho) {
        handleEcho(messageId, appId, metadata);
        return;
    } else if (quickReply) {
        handleQuickReply(senderID, quickReply, messageId);
        return;
    }


    if (messageText) {
        //send message to api.ai
        sendToDialogFlow(senderID, messageText);
    } else if (messageAttachments) {
        handleMessageAttachments(messageAttachments, senderID);
    }
}


function handleMessageAttachments(messageAttachments, senderID){
    //for now just reply
    sendTextMessage(senderID, "Attachment received. Thank you.");
}

function handleQuickReply(senderID, quickReply, messageId) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s", messageId, quickReplyPayload);
    //send payload to api.ai
    sendToDialogFlow(senderID, quickReplyPayload);
}

//https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-echo
function handleEcho(messageId, appId, metadata) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", messageId, appId, metadata);
}

function handleDialogFlowAction(sender, action, messages, contexts, parameters) {

    switch (action) {
        case "get-facebook-user":
            sendTextMessage(sender, "Hello " + sender);
            break;
        case "get-leave-balance":
            getLeaveBalance(sender);
            break; 
        case "get-emp-count":
            getEmpCount(sender);
            break;     
        case "get-holiday-calendar":
            getHoliday(sender, parameters, contexts, messages);
            break;     
        case "get-vacant-position":
            getVacancy(sender, parameters, contexts, messages);
            break;  
        case "get-phone-num":
            getPhoneNum(sender, parameters, contexts, messages);
            break;  
        case "sf-register":
            registerSfUserToDb(sender);
            break;
        default:
            //unhandled action, just send back the text
            handleMessages(messages, sender);
    }
}

function getPhoneNum(sender, parameters, contexts, messages) {
    
    console.log('Phone Param: ' + JSON.stringify(parameters));
    console.log('Phone Context: ' + JSON.stringify(contexts));
    console.log('Phone Message: ' + JSON.stringify(messages));

    
    if(typeof parameters.fields.emp_name.stringValue !== 'undefined'
        && parameters.fields.emp_name.stringValue){

        var sName = parameters.fields.emp_name.stringValue;

        request.get(config.SF_APIURL + '/odata/v2/User?$select=defaultFullName,cellPhone,businessPhone,custom03&$format=json', 
        {
            'auth': {
                    'user': config.SF_USER,
                    'pass': config.SF_PASSWORD,
                    'sendImmediately': false
            }
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                let oDataResponse = JSON.parse(body);
                
                let j = 1;
                var output = "";

                for (var i = 0; i < oDataResponse.d.results.length; i++) {
                    var results = oDataResponse.d.results[i];

                    if(!results.defaultFullName){
                        continue;
                    }
                    var sUpperName = results.defaultFullName.toUpperCase();
                    var sSearch = sName.toUpperCase();
                    console.log(sSearch + " " + sUpperName);
                    if(sUpperName.search(sSearch) !== -1){
                        var k = j.toString();
                        var sDept = "";
                        var sPhone = "";

                        sDept = results.custom03? results.custom03: "ไม่มีแผนก";
                        sPhone = results.businessPhone? results.businessPhone: "ไม่มีหมายเลขติดต่อ";


                        output = `${output}${k}: ${results.defaultFullName} / ${sDept} / ${sPhone}`;
                        if (i < oDataResponse.d.results.length - 1) {
                            output = output + "\n";
                        }
                        j = j + 1;
                    }
                }    
                
                if(output === ""){
                   output = `ไม่มีพนักงานที่ค้นหาค่ะ`;
                }
                else{
                    output = output.slice(0, -1);
                }

                sendTextMessage(sender, output);

            } else {
                console.error(response.error);
            } 

        });
    } else {
        sendTextMessage(sender, messages[0].text.text[0]);
    }
}

function getVacancy(sender, parameters, contexts, messages) {
    
    console.log('Vacancy Param: ' + JSON.stringify(parameters));
    console.log('Vacancy Context: ' + JSON.stringify(contexts));
    console.log('Vacancy Message: ' + JSON.stringify(messages));

    
    if(typeof parameters.fields.Division.listValue.values !== 'undefined'
        && parameters.fields.Division.listValue.values.length > 0){
        var sDivision = parameters.fields.Division.listValue;
        
        sDivision.values.forEach((sValue) => {
            console.log("Division: " + sValue.stringValue);
            if(sValue.stringValue !== "100127" && sValue.stringValue !== "ALL" && 
             sValue.stringValue !== "10000008" && sValue.stringValue !== "100317"){
                sendTextMessage(sender, "ไม่มีฝ่ายที่ต้องการดูค่ะ");
                return;
            }
        });

        request.get(config.SF_APIURL + '/odata/v2/Position?$filter=vacant+eq+true+and+effectiveStatus+eq+%27A%27&$select=code,externalName_en_GB,vacant,divisionNav/externalCode&$format=json&$expand=divisionNav', 
        {
            'auth': {
                    'user': config.SF_USER,
                    'pass': config.SF_PASSWORD,
                    'sendImmediately': false
            }
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                let oDataResponse = JSON.parse(body);
                
                let j = 1;
                var output = "";

                for (var i = 0; i < oDataResponse.d.results.length; i++) {
                    var results = oDataResponse.d.results[i];
                    var isFound = false;
                    
                    if(results.divisionNav === null){
                        continue;
                    }
                    
                    console.log(i.toString() + " " + results.code + " " + results.divisionNav.externalCode);
                    
                    isFound = false;
                    sDivision.values.forEach((sValue) => {
                        if(sValue.stringValue == results.divisionNav.externalCode 
                            || sValue.stringValue == "ALL"){
                            isFound = true;
                        }
                    });

                    if(isFound)
                    {
                        console.log(j);
                        var k = j.toString();
                        if(j<=10){
                            output = `${output}${k}: ${results.code} ${results.externalName_en_GB}`;
                            if (i < oDataResponse.d.results.length - 1) {
                                output = output + "\n";
                            }
                        }
                        j = j + 1;
                    }
                }    
                
                if(output === ""){
                   output = `ไม่ตำแหน่งว่างค่ะ`;
                }
                else{
                    j = j - 1;
                    var output2 = `ตำแหน่งว่างมี ${j} รายการ`;   
                    if(j > 10){
                        output2 = `${output2} 10 รายการแรก ได้แก่\n`;
                    }else{
                        output2 = `${output2} ได้แก่\n`;
                    }
                    output = `${output2}${output}`;
                    output = output.slice(0, -1);
                }

                sendTextMessage(sender, output);

            } else {
                console.error(response.error);
            } 

        });
    } else {
        sendTextMessage(sender, messages[0].text.text[0]);
    }
}

function getHoliday(sender, parameters, contexts, messages) {
    
    console.log('Holiday Param: ' + JSON.stringify(parameters));
    console.log('Holiday Context: ' + JSON.stringify(contexts));
    console.log('Holiday Message: ' + JSON.stringify(messages));


    if(typeof parameters.fields.date_param.structValue !== 'undefined'){
        var dateParam = parameters.fields.date_param.structValue.fields;
        var begDate = new Date(dateParam.startDateTime.stringValue);
        var endDate = new Date(dateParam.endDateTime.stringValue);

        begDate.setHours(0,0,0,0);
        endDate.setHours(0,0,0,0);

        var begDay = dateFormat(begDate, "d mmm yyyy");
        var endDay = dateFormat(endDate, "d mmm yyyy");
        console.log(begDay);
        console.log(endDay);

        // = `วันหยุดในช่วง ${begDay} ถึง ${endDay} มีดังนี้ค่ะ`;
        //sendTextMessage(sender, output);

        request.get(config.SF_APIURL + '/odata/v2/HolidayCalendar(\'SET_Holiday_Calendar\')/holidayAssignments?$expand=holidayNav&$format=json', 
        {
            'auth': {
                    'user': config.SF_USER,
                    'pass': config.SF_PASSWORD,
                    'sendImmediately': false
            }
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                let oDataResponse = JSON.parse(body);
                
                let j = 1;
                var output = "";

                for (var i = 0; i < oDataResponse.d.results.length; i++) {
                    var results = oDataResponse.d.results[i];
                    console.log("Holiday Name " + results.holidayNav.name_localized);
                    //console.log(results);
                    var xmlDate = new Date(results.date.match(/\d+/)[0] * 1);
                    console.log("Holiday Name Date" + xmlDate);
                    
                    if(xmlDate >= begDate && xmlDate <= endDate)
                    {
                        //console.log(j);
                        var k = j.toString();
                        var myDate = new Date(results.date.match(/\d+/)[0] * 1);
                        var day = dateFormat(myDate, "dddd d mmmm yyyy");
                        if(j === 1){
                            output = `วันหยุดในช่วง ${begDay} ถึง ${endDay} มีดังนี้ค่ะ\n`;
                        }
                        output = `${output}${k}: ${day} - ${results.holidayNav.name_localized}`;
                        
                        if (i < oDataResponse.d.results.length - 1) {
                            output = output + "\n";
                        }
                        j = j + 1;
                    }
                }
                
                if(output === ""){
                    output = `ไม่มีวันหยุดในช่วง ${begDay} ถึง ${endDay} ค่ะ`;
                }

                console.log(output);
                sendTextMessage(sender, output);

                //sendTextMessage(sender, "จำนวนพนักงานทั้งหมด " + userCount + " คน");
            } else {
                console.error(response.error);
            } 

        });
    } else {
        sendTextMessage(sender, messages[0].text.text[0]);
    }
}

function getEmpCount(sender) {
    
    request.get(config.SF_APIURL + '/odata/v2/User/$count', 
    {
        'auth': {
                'user': config.SF_USER,
                'pass': config.SF_PASSWORD,
                'sendImmediately': false
        }
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            //console.log("Body: " + body);
            let response = JSON.parse(body);
            console.log('EmpCount: ' + userCount);
            sendTextMessage(sender, "จำนวนพนักงานทั้งหมด " + userCount + " คน");
        } else {
            console.error(response.error);
        } 

    });

}

function getLeaveBalance(sender) {
    
    var pool = new pg.Pool(config.PG_CONFIG);
    pool.connect(function(err, client, done) {
    if (err) {
        return console.error('Error acquiring client', err.stack);
    }
    var rows = [];
    client.query(`SELECT fb_id, sf_id FROM sfusers WHERE fb_id='${sender}' LIMIT 1`,
        function(err, result) {
            if (err) {
                console.log('Query error: ' + err);
            } else {
                if (result.rows.length === 0) {
                    console.log("Not found -> Insert");
                    sendTextMessage(sender,'ไม่พบข้อมูล กรุณาลงทะเบียน');
                } else {
                    console.log(result.rows);
                    var sfuser = result.rows[0]['sf_id'];
                    console.log("Found -> No insert " + sfuser);
                    if(sfuser){
                        request.get(config.SF_APIURL + '/odata/v2/EmpTimeAccountBalance?$filter=userId eq \'' + sfuser + '\'  and timeAccountType eq \'Annual Leave\'&$format=json', 
                        {
                            'auth': {
                                    'user': config.SF_USER,
                                    'pass': config.SF_PASSWORD,
                                    'sendImmediately': false
                            }
                        }, function (error, response, body) {
                            if (!error && response.statusCode == 200) {

                                console.log(body);
                                var user = JSON.parse(body);
                                console.log('leave Banlance: ' + user.d.results[0].balance);
                                sendTextMessage(sender, "วันลาพักร้อนคงเหลือ " + user.d.results[0].balance + " วัน");
                            } else {
                                console.error(response.error);
                            }

                        });

                        request.get(config.SF_APIURL + '/odata/v2/EmpTimeAccountBalance?$filter=userId eq \'' + sfuser + '\'  and timeAccountType eq \'Sick Leave\'&$format=json', 
                        {
                            'auth': {
                                    'user': config.SF_USER,
                                    'pass': config.SF_PASSWORD,
                                    'sendImmediately': false
                            }
                        }, function (error, response, body) {
                            if (!error && response.statusCode == 200) {

                                console.log(body);
                                var user = JSON.parse(body);
                                console.log('leave Banlance: ' + user.d.results[0].balance);
                                sendTextMessage(sender, "วันลาป่วยคงเหลือ " + user.d.results[0].balance + " วัน");
                            } else {
                                console.error(response.error);
                            }

                        });

                    } else {
                        sendTextMessage(sender,'ไม่พบข้อมูล กรุณาลงทะเบียน');
                    }
                }
            }
        });
    });
    pool.end();

}

function registerSfUserToDb(sender) {

    request.get('https://api10preview.sapsf.com:443/odata/v2/User(\'Emeritis_RI\')?$select=userId,firstName,lastName&$format=json', 
        {
            'auth': {
                    'user': 'Emeritis_RI@thestockexT1',
                    'pass': 'Emeritis@2020',
                    'sendImmediately': false
        }
    }, function (error, response, body) {
		if (!error && response.statusCode == 200) {

			var user = JSON.parse(body);
            console.log('getUserData: ' + user.d.userId);
            sendTextMessage(sender, "สวัสดีค่ะคุณ " + user.d.userId + ': ' +
                user.d.firstName + " " + user.d.lastName);
	/*		if (user.first_name) {

                sendTextMessage(userId, "สวัสดีค่ะคุณ " + user.first_name + '! ' +
                    'ต้องการสอบถามข้อมูลด้านใดคะ');

				console.log("FB user: %s %s, %s", user.first_name, user.last_name, user.profile_pic);

                var pool = new pg.Pool(config.PG_CONFIG);
                pool.connect(function(err, client, done) {
                if (err) {
                    return console.error('Error acquiring client', err.stack);
                }
                var rows = [];
                client.query(`SELECT fb_id, sf_id FROM sfusers WHERE fb_id='${userId}' LIMIT 1`,
                    function(err, result) {
                        if (err) {
                            console.log('Query error: ' + err);
                        } else {
                            if (result.rows.length === 0) {
                                console.log("Not found -> Insert");
                                sendTextMessage(userId,'ไม่พบข้อมูล กรุณาลงทะเบียน');
                            /*    let sql = 'INSERT INTO sfusers (fb_id) ' +
									'VALUES ($1)';
                                client.query(sql,
                                    [
                                        userId
                                    ]);
                            */ /*
                            } else {
                                console.log(result.rows);
                                console.log("Found -> No insert");
                                if(result.rows.sf_id){
                                    sendTextMessage(userId,'SF User -> ' + result.rows.sf_id );
                                } else {
                                    sendTextMessage(userId,'ไม่พบข้อมูล กรุณาลงทะเบียน');
                                }
                            }
                        }
                    });
                });
                pool.end();

			} else {
				console.log("Cannot get data for fb user with id",
					userId);
            }
            */
		} else {
			console.error(response.error);
		}

	});

}

function handleMessage(message, sender) {
    switch (message.message) {
        case "text": //text
            message.text.text.forEach((text) => {
                if (text !== '') {
                    sendTextMessage(sender, text);
                }
            });
            break;
        case "quickReplies": //quick replies
            let replies = [];
            message.quickReplies.quickReplies.forEach((text) => {
                let reply =
                    {
                        "content_type": "text",
                        "title": text,
                        "payload": text
                    }
                replies.push(reply);
            });
            sendQuickReply(sender, message.quickReplies.title, replies);
            break;
        case "image": //image
            sendImageMessage(sender, message.image.imageUri);
            break;
    }
}


function handleCardMessages(messages, sender) {

    let elements = [];
    for (var m = 0; m < messages.length; m++) {
        let message = messages[m];
        let buttons = [];
        for (var b = 0; b < message.card.buttons.length; b++) {
            let isLink = (message.card.buttons[b].postback.substring(0, 4) === 'http');
            let button;
            if (isLink) {
                button = {
                    "type": "web_url",
                    "title": message.card.buttons[b].text,
                    "url": message.card.buttons[b].postback
                }
            } else {
                button = {
                    "type": "postback",
                    "title": message.card.buttons[b].text,
                    "payload": message.card.buttons[b].postback
                }
            }
            buttons.push(button);
        }


        let element = {
            "title": message.card.title,
            "image_url":message.card.imageUri,
            "subtitle": message.card.subtitle,
            "buttons": buttons
        };
        elements.push(element);
    }
    sendGenericMessage(sender, elements);
}


function handleMessages(messages, sender) {
    let timeoutInterval = 1100;
    let previousType ;
    let cardTypes = [];
    let timeout = 0;
    for (var i = 0; i < messages.length; i++) {

        if ( previousType == "card" && (messages[i].message != "card" || i == messages.length - 1)) {
            timeout = (i - 1) * timeoutInterval;
            setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
            cardTypes = [];
            timeout = i * timeoutInterval;
            setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
        } else if ( messages[i].message == "card" && i == messages.length - 1) {
            cardTypes.push(messages[i]);
            timeout = (i - 1) * timeoutInterval;
            setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
            cardTypes = [];
        } else if ( messages[i].message == "card") {
            cardTypes.push(messages[i]);
        } else  {

            timeout = i * timeoutInterval;
            setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
        }

        previousType = messages[i].message;

    }
}

function handleDialogFlowResponseLine(event, response) {
    let responseText = response.fulfillmentMessages.fulfillmentText;
    sendTextMessageLine(event, responseText);
}

function handleDialogFlowResponse(sender, response) {
    let responseText = response.fulfillmentMessages.fulfillmentText;

    let messages = response.fulfillmentMessages;
    let action = response.action;
    let contexts = response.outputContexts;
    let parameters = response.parameters;

    sendTypingOff(sender);

    if (isDefined(action)) {
        handleDialogFlowAction(sender, action, messages, contexts, parameters);
    } else if (isDefined(messages)) {
        handleMessages(messages, sender);
    } else if (responseText == '' && !isDefined(action)) {
        //dialogflow could not evaluate input.
        sendTextMessage(sender, "I'm not sure what you want. Can you be more specific?");
    } else if (isDefined(responseText)) {
        sendTextMessage(sender, responseText);
    }
}

async function sendToDialogFlow(sender, textString, params) {

    sendTypingOn(sender);

    try {
        const sessionPath = sessionClient.sessionPath(
            config.GOOGLE_PROJECT_ID,
            sessionIds.get(sender)
        );

        const request = {
            session: sessionPath,
            queryInput: {
                text: {
                    text: textString,
                    languageCode: config.DF_LANGUAGE_CODE,
                },
            },
            queryParams: {
                payload: {
                    data: params
                }
            }
        };
        const responses = await sessionClient.detectIntent(request);

        const result = responses[0].queryResult;
        handleDialogFlowResponse(sender, result);
    } catch (e) {
        console.log('error');
        console.log(e);
    }

}

async function sendToDialogFlowLine(event, params) {

    //sendTypingOn(sender);
    console.log("User ID Line: " + event.source.userId);
    console.log("Message Line: " + event.message.text);

    let chatId = getChatId(event);
    if (!sessionIds.has(chatId)) {
        sessionIds.set(chatId, uuid.v4());
    }

    try {
        const sessionPath = sessionClient.sessionPath(
            config.GOOGLE_PROJECT_ID,
            sessionIds.get(chatId)
        );

        const request = {
            session: sessionPath,
            queryInput: {
                text: {
                    text: event.message.text,
                    languageCode: config.DF_LANGUAGE_CODE,
                },
            },
            queryParams: {
                payload: {
                    data: params
                }
            }
        };
        const responses = await sessionClient.detectIntent(request);

        const result = responses[0].queryResult;
        handleDialogFlowResponseLine(event, result);
    } catch (e) {
        console.log('error');
        console.log(e);
    }

}

function getChatId(event) {
    if (event.source) {

      if (event.source.type === 'user') {
        return event.source.userId;
      }

      if (event.source.type === 'group') {
        return event.source.groupId;
      }

      if (event.source.type === 'room') {
        return event.source.roomId;
      }
    }
    return null;
}


function sendTextMessageLine(event, text) {

    var msg = {
        type: 'text',
        text: text
    };

    return lineClient.replyMessage(event.replyToken, msg);
    
}

function sendTextMessage(recipientId, text) {
    
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: text
        }
    }
    callSendAPI(messageData);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId, imageUrl) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: imageUrl
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "image",
                payload: {
                    url: config.SERVER_URL + "/assets/instagram_logo.gif"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "audio",
                payload: {
                    url: config.SERVER_URL + "/assets/sample.mp3"
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example videoName: "/assets/allofus480.mov"
 */
function sendVideoMessage(recipientId, videoName) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "video",
                payload: {
                    url: config.SERVER_URL + videoName
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example fileName: fileName"/assets/test.txt"
 */
function sendFileMessage(recipientId, fileName) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "file",
                payload: {
                    url: config.SERVER_URL + fileName
                }
            }
        }
    };

    callSendAPI(messageData);
}



/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId, text, buttons) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: text,
                    buttons: buttons
                }
            }
        }
    };

    callSendAPI(messageData);
}


function sendGenericMessage(recipientId, elements) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: elements
                }
            }
        }
    };

    callSendAPI(messageData);
}


function sendReceiptMessage(recipientId, recipient_name, currency, payment_method,
                            timestamp, elements, address, summary, adjustments) {
    // Generate a random receipt ID as the API requires a unique ID
    var receiptId = "order" + Math.floor(Math.random() * 1000);

    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "receipt",
                    recipient_name: recipient_name,
                    order_number: receiptId,
                    currency: currency,
                    payment_method: payment_method,
                    timestamp: timestamp,
                    elements: elements,
                    address: address,
                    summary: summary,
                    adjustments: adjustments
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId, text, replies, metadata) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: text,
            metadata: isDefined(metadata)?metadata:'',
            quick_replies: replies
        }
    };

    callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {

    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "mark_seen"
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {


    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_on"
    };

    callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {


    var messageData = {
        recipient: {
            id: recipientId
        },
        sender_action: "typing_off"
    };

    callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "button",
                    text: "Welcome. Link your account.",
                    buttons: [{
                        type: "account_link",
                        url: config.SERVER_URL + "/authorize"
                    }]
                }
            }
        }
    };

    callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
    request({
        uri: 'https://graph.facebook.com/v3.2/me/messages',
        qs: {
            access_token: config.FB_PAGE_TOKEN
        },
        method: 'POST',
        json: messageData

    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var recipientId = body.recipient_id;
            var messageId = body.message_id;

            if (messageId) {
                console.log("Successfully sent message with id %s to recipient %s",
                    messageId, recipientId);
            } else {
                console.log("Successfully called Send API for recipient %s",
                    recipientId);
            }
        } else {
            console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
        }
    });
}



/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfPostback = event.timestamp;

    // The 'payload' param is a developer-defined field which is set in a postback
    // button for Structured Messages.
    var payload = event.postback.payload;

    switch (payload) {
        case 'GET_STARTED':
            greetUserText(senderID);
            break;
        default:
            //unindentified payload
            sendTextMessage(senderID, "I'm not sure what you want. Can you be more specific?");
            break;

    }

    console.log("Received postback for user %d and page %d with payload '%s' " +
        "at %d", senderID, recipientID, payload, timeOfPostback);

}

function greetUserText(userId) {
	//first read user firstname
	request({
		uri: 'https://graph.facebook.com/v3.2/' + userId,
		qs: {
			access_token: config.FB_PAGE_TOKEN
		}

	}, function (error, response, body) {
		if (!error && response.statusCode == 200) {

			var user = JSON.parse(body);
			console.log('getUserData: ' + user);
			if (user.first_name) {

                /*
                sendTextMessage(userId, "สวัสดีค่ะคุณ " + user.first_name + '! ' +
                    'ต้องการสอบถามข้อมูลด้านใดคะ');
                */

				console.log("FB user: %s %s, %s", user.first_name, user.last_name, user.profile_pic);

                var pool = new pg.Pool(config.PG_CONFIG);
                pool.connect(function(err, client, done) {
                if (err) {
                    return console.error('Error acquiring client', err.stack);
                }
                var rows = [];
                client.query(`SELECT fb_id, sf_id FROM sfusers WHERE fb_id='${userId}' LIMIT 1`,
                    function(err, result) {
                        if (err) {
                            console.log('Query error: ' + err);
                        } else {
                            if (result.rows.length === 0) {
                                console.log("Not found -> Insert");
                                sendTextMessage(userId,'ไม่พบข้อมูล กรุณาลงทะเบียน');
                            /*    let sql = 'INSERT INTO sfusers (fb_id) ' +
									'VALUES ($1)';
                                client.query(sql,
                                    [
                                        userId
                                    ]);
                            */
                            } else {
                                console.log(result.rows);
                                var sfuser = result.rows[0]['sf_id'];
                                console.log("Found -> No insert " + sfuser);
                                if(sfuser){
                                    //sendTextMessage(userId,'SF User -> ' + sfuser );
                                    request.get(config.SF_APIURL + '/odata/v2/User(\'' + sfuser + '\')?$select=userId,firstName,lastName&$format=json', 
                                    {
                                        'auth': {
                                                'user': config.SF_USER,
                                                'pass': config.SF_PASSWORD,
                                                'sendImmediately': false
                                        }
                                    }, function (error, response, body) {
                                        if (!error && response.statusCode == 200) {

                                            var user = JSON.parse(body);
                                            console.log('getUserData: ' + user.d.userId);
                                            sendTextMessage(userId, "สวัสดีค่ะคุณ " + user.d.userId + ': ' +
                                                user.d.firstName + " " + user.d.lastName);
                                        } else {
                                            console.error(response.error);
                                        }

                                    });

                                } else {
                                    sendTextMessage(userId,'ไม่พบข้อมูล กรุณาลงทะเบียน');
                                }
                            }
                        }
                    });
                });
                pool.end();

			} else {
				console.log("Cannot get data for fb user with id",
					userId);
			}
		} else {
			console.error(response.error);
		}

	});
}



/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    // All messages before watermark (a timestamp) or sequence have been seen.
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;

    console.log("Received message read event for watermark %d and sequence " +
        "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;

    var status = event.account_linking.status;
    var authCode = event.account_linking.authorization_code;

    console.log("Received account link event with for user %d with status %s " +
        "and auth code %s ", senderID, status, authCode);
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var delivery = event.delivery;
    var messageIDs = delivery.mids;
    var watermark = delivery.watermark;
    var sequenceNumber = delivery.seq;

    if (messageIDs) {
        messageIDs.forEach(function (messageID) {
            console.log("Received delivery confirmation for message ID: %s",
                messageID);
        });
    }

    console.log("All message before %d were delivered.", watermark);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfAuth = event.timestamp;

    // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
    // The developer can set this to an arbitrary value to associate the
    // authentication callback with the 'Send to Messenger' click event. This is
    // a way to do account linking when the user clicks the 'Send to Messenger'
    // plugin.
    var passThroughParam = event.optin.ref;

    console.log("Received authentication for user %d and page %d with pass " +
        "through param '%s' at %d", senderID, recipientID, passThroughParam,
        timeOfAuth);

    // When an authentication is received, we'll send a message back to the sender
    // to let them know it was successful.
    sendTextMessage(senderID, "Authentication successful");
}

function handleEvent(event) {

    console.log(event);
    if (event.type === 'message' && event.message.type === 'text') {
        handleMessageEvent(event);
    } else {
        return Promise.resolve(null);
    }
}

function handleMessageEvent(event) {

    if (event.message.text) {
        console.log("send message to api.ai");
        sendToDialogFlowLine(event);
    }

    /*
    var msg = {
        type: 'text',
        text: 'Hello'
    };

    return lineClient.replyMessage(event.replyToken, msg);
    */
}
  
/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */

function verifyRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];

    if (!signature) {
        signature = req.headers["X-Line-Signature"];
        if (!signature) {
            throw new Error('Couldn\'t validate the signature.');
        } else {
            var elements = signature.split('=');
            var method = elements[0];
            var signatureHash = elements[1];
    
            var expectedHash = crypto.createHmac('sha256', config.LINE_CONFIG.channelSecret)
                .update(buf)
                .digest('hex');
    
            if (signatureHash != expectedHash) {
                throw new Error("Couldn't validate the request signature.");
            }
        }
    }


    if (!signature) {
        throw new Error('Couldn\'t validate the signature.');
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', config.FB_APP_SECRET)
            .update(buf)
            .digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}

function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false;
    }

    if (!obj) {
        return false;
    }

    return obj != null;
}

// Spin up the server
app.listen(app.get('port'), function () {
    console.log('running on port', app.get('port'))
})
