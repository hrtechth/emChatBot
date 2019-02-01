'use strict';

const config = require('../config');
const express = require('express');
const fbservice = require('../services/fb-service');

const router = express.Router();

router.get('/webview', function (req, res){
    res.render('sfuser-register');
});


router.get('/save', function (req, res){
    let body = req.body;
    let response = `${body.sfinput} psid = ${body.psid}`;
    fbservice.sendTextMessage(body.psid, response);
});


module.exports = router;