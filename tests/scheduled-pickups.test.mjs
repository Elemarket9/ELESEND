import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scheduledPickupReminder,validatePickupSchedule} from '../services/api/modules/orders/index.mjs';
import {buildParcelQuoteRequest,isQuoteBoundToInputs} from '../apps/mobile/src/booking-contract.js';

const now=new Date('2026-11-18T12:00:00.000Z');
const windowFrom=(start,end)=>({startAt:start.toISOString(),endAt:end.toISOString()});

test('large truck classes require scheduled pickup while other classes may book now',()=>{
 assert.throws(()=>validatePickupSchedule(undefined,'box_truck',now),/Choose a pickup date/);
 assert.throws(()=>validatePickupSchedule(undefined,'long_vehicle',now),/Choose a pickup date/);
 assert.equal(validatePickupSchedule(undefined,'pickup',now),null);
});

test('scheduled window accepts a future local ISO window within 14 days',()=>{
 const value=windowFrom(new Date('2026-11-19T08:00:00.000Z'),new Date('2026-11-19T09:00:00.000Z'));
 assert.deepEqual(validatePickupSchedule(value,'box_truck',now),value);
});

test('scheduled pickup refuses past, over-14-day and overlong windows',()=>{
 assert.throws(()=>validatePickupSchedule(windowFrom(new Date('2026-11-18T11:59:59Z'),new Date('2026-11-18T12:30:00Z')),'car',now),/future/);
 assert.throws(()=>validatePickupSchedule(windowFrom(new Date('2026-12-03T12:00:01Z'),new Date('2026-12-03T13:00:00Z')),'car',now),/14 days/);
 assert.throws(()=>validatePickupSchedule(windowFrom(new Date('2026-12-02T11:00:00Z'),new Date('2026-12-02T13:00:00Z')),'car',now),/14 days/);
 assert.throws(()=>validatePickupSchedule(windowFrom(new Date('2026-11-19T08:00:00Z'),new Date('2026-11-19T12:00:01Z')),'car',now),/four hours/);
 assert.throws(()=>validatePickupSchedule(windowFrom(new Date('2026-11-19T09:00:00Z'),new Date('2026-11-19T08:00:00Z')),'car',now),/no longer than four hours/);
});

test('scheduled rider reminder bands occur at 60 and 15 minutes',()=>{
 assert.equal(scheduledPickupReminder('2026-11-18T13:00:00.000Z',now),60);
 assert.equal(scheduledPickupReminder('2026-11-18T12:15:00.000Z',now),15);
 assert.equal(scheduledPickupReminder('2026-11-18T12:14:00.000Z',now),15);
 assert.equal(scheduledPickupReminder('2026-11-18T13:01:00.000Z',now),null);
 assert.equal(scheduledPickupReminder('2026-11-18T12:00:00.000Z',now),null);
});

test('mobile contract carries the fixed pickup window and detects changed times',()=>{
 const pickup={address:'Tema Harbour',latitude:5.632,longitude:0.003,customerConfirmed:true};
 const destination={address:'Kumasi Central Market',latitude:6.6975,longitude:-1.6244,customerConfirmed:true};
 const pickupWindow={startAt:'2026-11-20T08:00:00.000Z',endAt:'2026-11-20T09:00:00.000Z'};
 const body=buildParcelQuoteRequest({pickup,destination,vehicle:'box_truck',weightG:5000000,recipientPhone:'0241234567',description:'Shop stock',pickupWindow});
 assert.deepEqual(body.pickupWindow,pickupWindow);
 const quote={id:'quote',requestBody:body};
 assert.equal(isQuoteBoundToInputs(quote,{...body}),true);
 assert.equal(isQuoteBoundToInputs(quote,{...body,pickupWindow:{...pickupWindow,endAt:'2026-11-20T10:00:00.000Z'}}),false);
});

test('scheduled pickup migration stores both bounds and staff lead time',()=>{
 const sql=readFileSync('database/migrations/079_scheduled_cargo_pickups.sql','utf8');
 assert.match(sql,/scheduled_pickup_start timestamptz/);
 assert.match(sql,/scheduled_pickup_end timestamptz/);
 assert.match(sql,/scheduled_dispatch_lead_minutes integer NOT NULL DEFAULT 1440/);
 assert.match(sql,/BETWEEN 30 AND 10080/);
});
