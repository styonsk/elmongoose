# ElMongoose
Elmongoose allows you to sync your MongooseJS models with Elastic Search

Elmongoose is a [mongoose](http://mongoosejs.com/) plugin that integrates your data with [Elasticsearch](http://www.elasticsearch.org), to give you the full power of highly available, distributed search across your data.

#Install

```
npm install elmongo-flex
```

#Usage
```js
var mongoose = require('mongoose'),
    elmongo = require('elmongoose'),
    Schema = mongoose.Schema

var CatSchema = new Schema({
    name: String
})

// add the elmongo-flex plugin to your collection
CatSchema.plugin(elmongoose)

var Cat = mongoose.model('Cat', CatSchema)
```

Now setup the search index with your data:
```js
Cat.sync(function (err, numSynced) {
  // all cats are now searchable in elasticsearch
  console.log('number of cats synced:', numSynced)
})
```

At this point your Cat schema has all the power of Elasticsearch. Here's how you can search on the model:
```js
Cat.search({mustMatch: [{'name': 'Simba'}, {'age' : '14'}]}, function (err, results) {
 	console.log('search results', results)
})

// Perform a fuzzy search
Cat.search({ mustFuzzyMatch: [{'name': 'Simba'}] }, function (err, results) {
	// ...
})

// Combine "must" and "should" filters. 
// In this example we only get results where the cat's name is Simba and the breed is either feral or siamese
Cat.search({ mustMatch : [{'name': 'Simba'}], shouldMatch : [{'breed' : 'feral'}, {'breed': 'siamese'}]}, function (err, results) {
	// ...
})
```

After the initial `.sync()`, any **Cat** models you create/edit/delete with mongoose will be up-to-date in Elasticsearch. Also, `ElMongoose` reindexes with zero downtime. This means that your data will always be available in Elasticsearch even if you're in the middle of reindexing.

#API

##`Model.sync(callback)`

Re-indexes your collection's data in Elasticsearch. After the first `.sync()` call, Elasticsearch will be all setup with your collection's data. You can re-index your data anytime using this function. Re-indexing is done with zero downtime, so you can keep making search queries even while `.sync()` is running, and your existing data will be searchable.

Example:
```js
Cat.sync(function (err, numSynced) {
	// all existing data in the `cats` collection is searchable now
    console.log('number of docs synced:', numSynced)
})
```

##`Model.search(searchOptions, callback)`

Perform a search query on your model. Any values you provide will override the default search options. The default options are:

```js
{
	//specify at least one filter...
	mustMatch: null,
    shouldMatch: null,
    mustFuzzyMatch: null,
    shouldFuzzyMatch: null,
    mustRange: null,
    shouldRange: null,

    //additional options
    fuzziness: 0.5, //used in mustFuzzyMatch and shouldFuzzyMatch filters only
    pageSize: 25,
    page: 1
}
```

##`Model.aggregateCount(options, callback)`

Perform a count aggregation on your model. Set options.groupBy to "yourFieldName" to get documents in an index grouped by that field with a count. Any values you provide will override the default search options. The default options are:

```js
{
	//Optional, specify filters
    mustMatch: null,
    shouldMatch: null,
    mustFuzzyMatch: null,
    shouldFuzzyMatch: null,
    mustRange: null,
    shouldRange: null,

    //Choose field to group by
    groupBy: null,

    //Additional options
    pageSize: 25,
    page: 1
}
```

##`Model.plugin(elmongo[, options])`

Gives your collection `.search()`, `aggregateCount()` and `.sync()` methods, and keeps Elasticsearch up-to-date with your data when you insert/edit/delete documents with mongoose. Takes an optional `options` object to tell `elmongo` the url that Elasticsearch is running at. In `options` you can specify:

 * `protocol` - http or https (defaults to `http`)
 * `host` - the host that Elasticsearch is running on (defaults to `localhost`)
 * `port` - the port that Elasticsearch is listening on (defaults to `9200`)
 * `prefix` - adds a prefix to the model's search index, allowing you to have separate indices for the same collection on an Elasticsearch instance (defaults to no prefix)
 * `url` - allows you to specify the protocol, host and port by just passing in a url eg. `https://elasticsearch.mydomain.com:9300`. The provided url must contain at least a host and port.
 * 'flatten' - the key of a sub document in your collection that you would like to flatten. Varying sub-document formats in mongoDB can cause errors when dumped into the same index in elastic search
 * `grouper` - the key whose value you would like to append to the keys in the flattened subdocuments. This prevents elastic search from throwing an error when you import documents with the same key but different data types (numer/date/string/etc...)

Suppose you have a test database and a development database both storing models in the `Cats` collection, but you want them to share one Elasticsearch instance. With the `prefix` option, you can separate out the indices used by `elmongo-flex` to store your data for test and development.

For tests, you could do something like:
 ```js
Cat.plugin(elmongo-flex, { host: 'localhost', port: 9200, prefix: 'test' })
 ```
And for development you could do something like:
```js
Cat.plugin(elmongo-flex, { host: 'localhost', port: 9200, prefix: 'development' })
```

This way, you can use the same `mongoose` collections for test and for development, and you will have separate search indices for them (so you won't have situations like test data showing up in development search results).

**Note**: there is no need to specify a `prefix` if you are using separate Elasticsearch hosts or ports. The `prefix` is simply for cases where you are sharing a single Elasticsearch instance for multiple codebases.

##`elmongoose.search(searchOptions, callback)`

You can use this function to make searches that are not limited to a specific collection. Use this to search across one or several collections at the same time (without making multiple roundtrips to Elasticsearch). The default options are the same as for `Model.search()`, with one extra key: `collections`. It defaults to searching all collections, but you can specify an array of collections to search on.

```js
elmongoose.search({ collections: [ 'cats', 'dogs' ], query: '*' }, function (err, results) {
	// ...
})
```

By default, `elmongoose.search()` will use `localhost:9200` (the default Elasticsearch configuration). To configure it to use a different url, use `elmongo.search.config(options)`.

##`elmongoose.search.config(options)`

Configure the Elasticsearch url that `elmongoose` uses to perform a search when `elmongoose.search()` is used. `options` can specify the same keys as `Model.plugin(elmongo-flex, options)`. `elmongoose.search.config()` has no effect on the configuration for individual collections - to configure the url for collections, use `Model.plugin()`.

Example:
```js
elmongoose.search.config({ host: something.com, port: 9300 })
```

#Autocomplete

To add autocomplete functionality to your models, specify which fields you want autocomplete on in the schema:
```js
var CatSchema = new Schema({
    name: { type: String, autocomplete: true },
    age: { type: Number },
    owner: { type: ObjectId, ref: 'Person' },
    nicknames: [ { type: String, autocomplete: true } ]
})

// add the elmongo-flex plugin to your collection
CatSchema.plugin(elmongoose)

var Cat = mongoose.model('Cat', CatSchema)

var kitty = new Cat({ name: 'simba' }).save()
```

Setup the search index using `.sync()`:
```js
Cat.sync(function (err, numSynced) {
  // all cats are now searchable in elasticsearch
  console.log('number of cats synced:', numSynced)
})
```

Now you have autocomplete on `name` and `nicknames` whenever you search on those fields:
```js
Cat.search({ query: 'si', fields: [ 'name' ] }, function (err, searchResults) {
    // any cats having a name starting with 'si' will show up in the search results
})
```

-------

## Running the tests

```
npm test
```

-------

## License

(The MIT License)

Copyright (c) by Sold. <tolga@usesold.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
