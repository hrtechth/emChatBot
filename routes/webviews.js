'use strict';

const config = require('../config');
const express = require('express');
const fbservice = require('../services/fb-service');

const router = express.Router();
const pg = require('pg');
pg.defaults.ssl = true;

router.get('/webview', function (req, res){
    res.render('sfuser-register');
});


router.get('/save', function (req, res) {
    let body = req.query;
    let response = `${body.sfinput} psid = ${body.psid}`;
    console.log(response);
    //fbservice.sendTextMessage(body.psid, response);
    let pool = new pg.Pool(config.PG_CONFIG);
    pool.connect(function (err, client, done) {
        if (err) {
            return console.error('Error acquiering client');
        }
        client.query("UPDATE public.sfusers SET sf_id=$1 WHERE fb_id=$2",
            [
                body.sfinput,
                body.psid
            ],
            function (err, result) {
                if(err === null) {
                    fbservice.sendTextMessage(body.psid, 'User registered');
                } else {
                    console.log('ERR: ' + err);
                }
            });
    });    
});


router.get('/settings', function (req, res){

    let pool = new pg.Pool(config.PG_CONFIG);
    pool.connect(function (err, client, done) {
        if (err) {
            return console.error('Error acquiering client');
        }
        client.query("SELECT sf_id FROM public.sfusers WHERE fb_id=$1",
            [
                req.query.psid
            ],
            function (err, result) {
                if(err === null) {
                    let settings = [];
                    if (result.rows.length > 0 && result.rows[0]['sf_id']) {
                        settings = result.rows[0];
                    }
                    res.json(settings);
                } else {
                    res.json([]);
                }
            }
        )
    })

});

module.exports = router;