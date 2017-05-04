import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { dbOptions } from '/imports/constants.js';

Meteor.users = new Mongo.Collection('users', dbOptions);
