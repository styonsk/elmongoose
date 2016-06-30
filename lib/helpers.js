var request = require('request'),
    mongoose = require('mongoose'),
    ObjectId = mongoose.Types.ObjectId,
    util = require('util'),
    url = require('url')

/**
 * Sends an http request using `reqOpts`, calls `cb` upon completion.
 * Upon ECONNRESET, backs off linearly in increments of 500ms with some noise to reduce concurrency.
 *
 * @param  {Object}   reqOpts   request options object
 * @param  {Function} cb        Signature: function (err, res, body)
 */
exports.backOffRequest = function (reqOpts, cb) {
    var maxAttempts = 3
    var backOffRate = 500

    function makeAttempts (attempts) {
        attempts++

        request(reqOpts, function (err, res, body) {
            if (err) {
                if (
                    (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT')
                 && attempts <= maxAttempts
                 ) {
                    var waitTime = backOffRate*attempts+Math.random()*backOffRate

                    setTimeout(function () {
                        makeAttempts(attempts)
                    }, waitTime)
                    return
                } else {
                    var error = new Error('elasticsearch request error: '+err)
                    error.details = err
                    error.attempts = attempts
                    error.reqOpts = reqOpts

                    return cb(error)
                }
            }

            // parse the response body as JSON
            try {
                var parsedBody = JSON.parse(body)
            } catch (parseErr) {
                var error = new Error('Elasticsearch did not send back a valid JSON reply: '+util.inspect(body, true, 10, true))
                error.elasticsearchReply = body
                error.reqOpts = reqOpts
                error.details = parseErr

                return cb(error)
            }

            // success case
            return cb(err, res, parsedBody)
        })
    }

    makeAttempts(0)
}

/**
 * Performs deep-traversal on `thing` and converts
 * any object ids to hex strings, and dates to ISO strings.
 *
 * @param  {Any type} thing
 */
exports.serialize = function (thing) {
    if (Array.isArray(thing)) {
        return thing.map(exports.serialize)
    } else if (thing instanceof ObjectId) {
        return thing.toString()
        //return thing.toHexString()
    } else if (thing instanceof Date) {
        return thing.toISOString()
    } else if (typeof thing === 'object' && thing !== null) {
        Object
        .keys(thing)
        .forEach(function (key) {
            thing[key] = exports.serialize(thing[key])
        })
        return thing
    } else {
        //return JSON.stringify(thing)
        return thing
    }
}

/**
 * Flattens sub documents in thing
 *
 * @param  {Any type} thing
 */
exports.flatten = function(thing, sufix) {
    var result = {};
    function recurse (cur, prop) {
        //if (Object(cur) !== cur) {
            prop = prop + sufix;
            result[prop] = cur;
        // } else if (Array.isArray(cur)) {
        //      for(var i=0, l=cur.length; i<l; i++)
        //          recurse(cur[i], prop + "[" + i + "]");
        //     if (l == 0)
        //         result[prop] = [];
        // } else {
        //     var isEmpty = true;
        //     for (var p in cur) {
        //         isEmpty = false;
        //         recurse(cur[p], prop ? prop+"."+p : p);
        //     }
        //     if (isEmpty && prop)
        //         result[prop] = {};
        // }
    }
    recurse(thing, "");
    return result;
}

/**
 * Serialize a mongoose model instance for elasticsearch.
 *
 * @param  {Mongoose model instance} model
 * @return {Object}
 */
exports.serializeModel = function (model,options) {
    // strip mongoose-added functions, and depopulate any populated model references
    var deflated = model.toObject({ depopulate: true })
    var serialized = exports.serialize(deflated)
    if(options.flatten && options.grouper){
        serialized[options.flatten] = exports.flatten(serialized[options.flatten], serialized[options.grouper])
    }
    return serialized
}

/**
 * Merge user-supplied `options` object with defaults (to configure Elasticsearch url)
 * @param  {Object} options
 * @return {Object}
 */
exports.mergeOptions = function (options) {
    // default options
    var defaultOptions = {
        protocol: 'http',
        host: 'localhost',
        port: null,
        prefix: ''
    }

    if (!options) {
        return defaultOptions
    }

    // if user specifies an `options` value, ensure it's an object
    if (typeof options !== 'object') {
        throw new Error('elmongoose options was specified, but is not an object. Got:'+util.inspect(options, true, 10, true))
    }

    var mergedOptions = {}

    if (options.url) {
        // node's url module doesn't parse imperfectly formed URLs sanely.
        // use a regex so the user can pass in urls flexibly.

        // Rules:
        // url must specify at least host and port (protocol falls back to options.protocol or defaults to http)
        // if `host`, `port` or `protocol` specified in `options` are different than those in url, throw.
        var rgxUrl = /^((http|https):\/\/)?(.+):([0-9]+)/
        var urlMatch = rgxUrl.exec(options.url)

        if (!urlMatch) {
            throw new Error('url from `options` must contain host and port. url: `'+options.url+'`.')
        }

        // if no protocol in url, default to options protocol, or http
        var protocol = urlMatch[2];
        if (protocol && options.protocol && protocol !== options.protocol) {
            // user passes in `protocol` and a different protocol in `url`.
            throw new Error('url specifies different protocol than protocol specified in `options`. Pick one to use in `options`.')
        }
        mergedOptions.protocol = protocol || options.protocol || defaultOptions.protocol

        var hostname = urlMatch[3];
        if (!hostname) {
            // hostname must be parseable from the url
            throw new Error('url from `options` must contain host and port. url: `'+options.url+'`.')
        }
        mergedOptions.host = hostname

        var port = urlMatch[4];
        if (!port) {
            // port must be specified in url
            throw new Error('url from `options` must contain host and port. url: `'+options.url+'`.')
        }

        if (port && options.port && port !== options.port) {
            // if port is specified in `options` too, and its a different value, throw.
            throw new Error('url specifies different port than port specified in `options`. Pick one to use in `options`.')
        }
        mergedOptions.port = port

        mergedOptions.prefix = typeof options.prefix === 'string' ? options.prefix : ''
    } else {
        Object.keys(defaultOptions).forEach(function (key) {
            mergedOptions[key] = options[key] || defaultOptions[key]
        })
    }
    mergedOptions.grouper = options.grouper
    mergedOptions.flatten = options.flatten

    return mergedOptions
}

/**
 * Merge the default elmongoose collection options with the user-supplied options object
 *
 * @param  {Object} options (optional)
 * @param  {Object}
 * @return {Object}
 */
exports.mergeModelOptions = function (options, model) {
    var mergedOptions = exports.mergeOptions(options)

    // use lower-case model name as elasticsearch type
    mergedOptions.type = model.collection.name.toLowerCase()

    return mergedOptions
}

/**
 * Merge the default elmongoose search options with the user-supplied `searchOpts`
 * @param  {Object} searchOpts
 * @return {Object}
 */
exports.mergeSearchOptions = function (searchOpts) {

    var defaultSearchOpts = {
        mustMatch: null,
        shouldMatch: null,
        mustFuzzyMatch: null,
        shouldFuzzyMatch: null,
        //Not Matching Option
        mustNotMatch: null,
        shouldNotMatch: null,
        mustAllMatch: null,
        shouldAllMatch: null,
        mustRange: null,
        shouldRange: null,
        mustMatchMulti: null,
        shouldMatchMulti: null,
        mustArray: null,
        shouldArray: null,
        sort: null,
        //query: '*',
        //terms: null,
        //fields: [ '_all' ],
        fuzziness: 0.0,
        //fuzzyFilter: {},
        //range: null,
        pageSize: 25,
        //multiValueSearchTerms: null,
        //aggregationTerms: null,
        page: 1
    }

    var mergedSearchOpts = {}

    // merge the user's `options` object with `defaultOptions`
    Object
    .keys(defaultSearchOpts)
    .forEach(function (key) {
        mergedSearchOpts[key] = searchOpts[key] || defaultSearchOpts[key]
    })

    return mergedSearchOpts
}

/**
 * Merge the default elmongoose agg options with the user-supplied `aggOpts`
 * @param  {Object} aggOpts
 * @return {Object}
 */
exports.mergeAggOptions = function (aggOpts) {

    var defaultAggOpts = {
        mustMatch: null,
        shouldMatch: null,
        mustFuzzyMatch: null,
        shouldFuzzyMatch: null,
        mustRange: null,
        shouldRange: null,
        groupBy: null,
        pageSize: 25,
        page: 1
    }

    var mergedAggOpts = {}

    // merge the user's `options` object with `defaultOptions`
    Object
    .keys(defaultAggOpts)
    .forEach(function (key) {
        mergedAggOpts[key] = aggOpts[key] || defaultAggOpts[key]
    })

    return mergedAggOpts
}

/**
 * Build term filters
 *
 * @param  {Object} termOpts
 * @return {Object}
 */
 exports.buildTermFilters = function (termOpts){
    var filters = [];
    for(var i = 0, keys = Object.keys(termOpts); i < keys.length; i++){
        var key = keys[i];
        if (Array.isArray(termOpts[key])) {
            //Use this instead of below if you want your array to be an or instead of an and
                // if array of terms, use terms filter
                // var termsFilter = {
                //     terms:{}
                // }

                // termsFilter.terms[key] = termOpts[key]
                // filters.push(termsFilter)
            for(var j=0; j < termOpts[key].length; j++){

                var termFilter = {
                    term: { }
                };
                termFilter.term[key] = termOpts[key][i];
                filters.push(termFilter);

            }

        } else{ 
            //if none of the above treat this as a primitive
            if (typeof termOpts[key] === 'string') {
                termOpts[key] = termOpts[key].toLowerCase();
            }

            var termFilter = {
                term: { }
            };

            termFilter.term[key] = termOpts[key];
            filters.push(termFilter);
        }
        
    }
    return filters;
}

/**
 * Build array filters
 *
 * @param  {Object} termOpts
 * @return {Object}
 */
 exports.buildArrayFilters = function (termOpts){
    var filters = [];
    //var keys = Object.keys(termOpts);
    for(var key in termOpts){
        if (Array.isArray(termOpts[key])) {
            //if array of terms, use terms filter
            var termsFilter = {
                terms:{}
            }

            termsFilter.terms[key] = termOpts[key]
            filters.push(termsFilter)

        } else{ 
            console.log("error: value is not an array");
        }
        
    }
    return filters;
}

/**
 * Build not matching query
 *
 * @param  {Object} mustNotOpts
 * @return {Object}
 */
exports.buildNotMatchingQuery = function (mustNotOpts) {
    var queries = [];
    //var keys = Object.keys(fuzzyOpts);
    for(var i=0, keys=Object.keys(mustNotOpts); i<keys.length; i++){
        var key = keys[i];
        if(Array.isArray(mustNotOpts[key])){
            var header = {
                "query": { 
                    "bool": {
                        "must_not": [],
                        "minimum_should_match": 1
                    }
                }
            }
            for(var j = 0; j < mustNotOpts[key].length; j++){
                var obj1 = {
                    "multi_match": {
                        "query": mustNotOpts[key][j],
                       "fields": key,
                                    // if analyzer causes zero terms to be produced from the query, return all results
                        "zero_terms_query": 'all',
                        "boost": 3
                        }
                };
                header.query.bool.must_not.push(obj1);

            }
            queries.push(header);

        } 
        else {
        //for each key value pair in fuzzyOpts build fuzzy query and append it to queries array
            var body = {
                "query": { 
                    "bool": {
                        "must_not": [
                            // exact match query with high boost so that exact matches are always returned and scored higher
                            {
                                "multi_match": {
                                    "query": mustNotOpts[key],
                                    "fields": key,
                                    // if analyzer causes zero terms to be produced from the query, return all results
                                    "zero_terms_query": 'all',
                                    "boost": 3
                                }
                            }
                            // fuzzy query with lower boost than exact match query
                            
                        ],
                        "minimum_should_match": 1
                    }
                }
            }
            queries.push(body);
        }
    }

    return queries;

}
}

/**
 * Build fuzzy matching query
 *
 * @param  {Object} fuzzyOpts
 * @return {Object}
 */
exports.buildFuzzyMatchingQuery = function (fuzzyOpts, fuzziness) {
    var queries = [];
    //var keys = Object.keys(fuzzyOpts);
    for(var i=0, keys=Object.keys(fuzzyOpts); i<keys.length; i++){
        var key = keys[i];
        if (Array.isArray(fuzzyOpts[key])) {

                //Use this instead of below if you want your array to be an or instead of an and
                    // if array of terms, use terms filter
                    // var termsFilter = {
                    //     terms:{}
                    // }

                    // termsFilter.terms[key] = termOpts[key]
                    // filters.push(termsFilter)
                var header = {
                    "query": { 
                        "bool": {
                            "should": [],
                            "minimum_should_match": 1
                        }
                    }
                }

                
                for(var j=0; j < fuzzyOpts[key].length; j++){

                    var obj1= {
                                "multi_match": {
                                    "query": fuzzyOpts[key][j],
                                    "fields": key,
                                    // if analyzer causes zero terms to be produced from the query, return all results
                                    "zero_terms_query": 'all',
                                    "boost": 3
                                }
                            };
                            // fuzzy query with lower boost than exact match query
                    var obj2= {
                                "multi_match": {
                                    "query": fuzzyOpts[key][j],
                                    "fields": key,
                                    // if analyzer causes zero terms to be produced from the query, return all results
                                    "zero_terms_query": 'all',
                                    "fuzziness": fuzziness,
                                    "boost": 1
                                }
                            };

                    
                    header.query.bool.should.push(obj1);
                    header.query.bool.should.push(obj2);

                }
                queries.push(header);

            } else{ 
                //if none of the above treat this as a primitive
                if (typeof fuzzyOpts[key] === 'string') {
                    fuzzyOpts[key] = fuzzyOpts[key].toLowerCase();
                }
                //for each key value pair in fuzzyOpts build fuzzy query and append it to queries array
                var body = {
                    "query": { 
                        "bool": {
                            "should": [
                                // exact match query with high boost so that exact matches are always returned and scored higher
                                {
                                    "multi_match": {
                                        "query": fuzzyOpts[key],
                                        "fields": key,
                                        // if analyzer causes zero terms to be produced from the query, return all results
                                        "zero_terms_query": 'all',
                                        "boost": 3
                                    }
                                },
                                // fuzzy query with lower boost than exact match query
                                {
                                    "multi_match": {
                                        "query": fuzzyOpts[key],
                                        "fields": key,
                                        // if analyzer causes zero terms to be produced from the query, return all results
                                        "zero_terms_query": 'all',
                                        "fuzziness": fuzziness,
                                        "boost": 1
                                    }
                                }
                            ],
                            "minimum_should_match": 1
                        }
                    }
                }
                queries.push(body);
            }
    }
    return queries;
}


/**
 * Build all matching query
 *
 * @param  {Object} allOpts
 * @return {Object}
 */
exports.buildAllMatchingQuery = function (allOpts) {
    var queries = [];
    for(var i=0; i < allOpts.length; i++){
        //for each value in allOpts, build a match all query
        var body = {
            "query": {
                "match": {
                  "_all": allOpts[i]
                }
            }
        }
        queries.push(body);
    }

    return queries;
}

/**
 * Build range filters
 *
 * @param  {Object} rangeOpts
 * @return {Object}
 */
exports.buildRangeFilter = function (rangeOpts) {
    var filters = [];
    //var keys = Object.keys(rangeOpts);
    for(var i=0, keys = Object.keys(rangeOpts); i < keys.length; i++){
        var key = keys[i];
        if (typeof rangeOpts[key] === 'object') {

            var rangeFilter = {
                range: { }
            }

            rangeFilter.range[key] = rangeOpts[key] 
            //console.log("rangeFilter", rangeFilter)

            filters.push(rangeFilter)
        } else{
            console.log("error: Range given is not an Object: " + rangeOpts[key]);
        }
    }

    return filters;
}

/**
 * Generate a search request body from `searchOpts`.
 *
 * @param  {Object} searchOpts
 * @return {Object}
 */
exports.mergeSearchBody = function (searchOpts) {
    // console.log('\nmergeSearchBody searchOpts', util.inspect(searchOpts, true, 10, true))
    var mustFilters = []
    var shouldFilters = []
    var body = {
        "filter":{
            "bool":{}
        }
    }

    //set response size (for paging)
    body.from = searchOpts.page ? (searchOpts.page - 1) * searchOpts.pageSize : 0
    body.size = searchOpts.pageSize

    //set sort if defined
    if(searchOpts.sort){
        body.sort = searchOpts.sort;
    }
    //set mustNotMatch filters
    if(searchOpts.mustNotMatch && Object.keys(searchOpts.mustNotMatch).length){
        console.log('Must Not Match');
        mustFilters = mustFilters.concat(exports.buildNotMatchingQuery(searchOpts.mustNotMatch));
    }
    //set shouldNotMatch filters
    if(searchOpts.shouldNotMatch && Object.keys(searchOpts.shouldNotMatch).length){
        console.log('Should Not Match');
        shouldFilters = shouldFilters.concat(exports.buildNotMatchingQuery(searchOpts.shouldNotMatch));
    }
    //set mustFuzzyMatch filters
    if(searchOpts.mustFuzzyMatch && Object.keys(searchOpts.mustFuzzyMatch).length){
        mustFilters = mustFilters.concat(exports.buildFuzzyMatchingQuery(searchOpts.mustFuzzyMatch, searchOpts.fuzziness));
    }

    //set shouldFuzzyMatch filters
    if(searchOpts.shouldFuzzyMatch && Object.keys(searchOpts.shouldFuzzyMatch).length){
        shouldFilters = shouldFilters.concat(exports.buildFuzzyMatchingQuery(searchOpts.shouldFuzzyMatch, searchOpts.fuzziness));
    }

    //set mustAllMatch filters
    if(searchOpts.mustAllMatch && Object.keys(searchOpts.mustAllMatch).length){
        mustFilters = mustFilters.concat(exports.buildAllMatchingQuery(searchOpts.mustAllMatch));
    }

    //set shouldAllMatch filters
    if(searchOpts.shouldAllMatch && Object.keys(searchOpts.shouldAllMatch).length){
        shouldFilters = shouldFilters.concat(exports.buildAllMatchingQuery(searchOpts.shouldAllMatch));
    }

    //set must filters
    if(searchOpts.mustMatch && Object.keys(searchOpts.mustMatch).length){
        mustFilters = mustFilters.concat(exports.buildTermFilters(searchOpts.mustMatch));
    }
  
    //set should filters
    if(searchOpts.shouldMatch && Object.keys(searchOpts.shouldMatch).length){
        shouldFilters = shouldFilters.concat(exports.buildTermFilters(searchOpts.shouldMatch));
    }

    //set must array filters
    if(searchOpts.mustArray && Object.keys(searchOpts.mustArray).length){
        mustFilters = mustFilters.concat(exports.buildArrayFilters(searchOpts.mustArray));
    }

    //set should array filters
    if(searchOpts.shouldArray && Object.keys(searchOpts.shouldArray).length){
        shouldFilters = shouldFilters.concat(exports.buildArrayFilters(searchOpts.shouldArray));
    }

    //set must range filters
    if(searchOpts.mustRange && Object.keys(searchOpts.mustRange).length){
        mustFilters = mustFilters.concat(exports.buildRangeFilter(searchOpts.mustRange));
    }
  
    //set should range filters
    if(searchOpts.shouldRange && Object.keys(searchOpts.shouldRange).length){
        shouldFilters = shouldFilters.concat(exports.buildRangeFilter(searchOpts.shouldRange));
    }

    if(mustFilters.length){
        body.filter.bool.must = mustFilters;
    }

    if(shouldFilters.length){
        body.filter.bool.should = shouldFilters;
    }
   
    console.log('\nmergeSearchBody body', util.inspect(body, true, 10, true))

    return body
}

/**
 * Generate a agg request body from `aggOpts`.
 *
 * @param  {Object} aggOpts
 * @return {Object}
 */
exports.mergeAggBody = function (aggOpts) {
    var mustFilters = []
    var shouldFilters = []
    var body = {}
    var aggBody = {
            "ElmongooseAgg":{
                "terms" : {"field" : aggOpts.groupBy,
                            "size" : 0} //show all results
            }
        }

    //set response size (for paging)
    body.from = aggOpts.page ? (aggOpts.page - 1) * aggOpts.pageSize : 0
    body.size = aggOpts.pageSize

    //set must filters
    if(aggOpts.mustMatch && Object.keys(aggOpts.mustMatch).length){
        mustFilters = mustFilters.concat(exports.buildTermFilters(aggOpts.mustMatch));
    }
  
    //set should filters
    if(aggOpts.shouldMatch && Object.keys(aggOpts.shouldMatch).length){
        shouldFilters = shouldFilters.concat(exports.buildTermFilters(aggOpts.shouldMatch));
    }

    if(mustFilters.length || shouldFilters.length){
        //if filters were set, create a top level agg to wrap your filters and aggBody in
        body.aggs = {
            "ElmongooseAggWrapper" : {
                "filter" : {
                    "bool" : {}
                },
                "aggs" : aggBody
            }
        }

        //add your filters
        if(mustFilters.length){
            body.aggs.ElmongooseAggWrapper.filter.bool.must = mustFilters;
        }
        if(shouldFilters.length){
            body.aggs.ElmongooseAggWrapper.filter.bool.should = shouldFilters;
        }
    } else {
        //if no filters were set just do a normal agg
        body.aggs = aggBody;
    }
   
    console.log('\nmergeAggBody body', util.inspect(body, true, 10, true))

    return body
}


/**
 * Make a search request using `reqOpts`, normalize results and call `cb`.
 *
 * @param  {Object}   reqOpts
 * @param  {Function} cb
 */
exports.doSearchAndNormalizeResults = function (searchUri, searchOpts, cb) {
    // merge `searchOpts` with default user-level search options
    searchOpts = exports.mergeSearchOptions(searchOpts)

    var body = exports.mergeSearchBody(searchOpts)
    

    var reqOpts = {
        method: 'POST',
        url: searchUri,
        body: JSON.stringify(body)
    }

    exports.backOffRequest(reqOpts, function (err, res, body) {
        if (err) {
            var error = new Error('Elasticsearch search error:'+util.inspect(err, true, 10, true))
            error.details = err

            return cb(error)
        }

        // console.log('\nsearch response body', util.inspect(body, true, 10, true))

        if (!body.hits) {
            var error = new Error('Unexpected Elasticsearch reply:'+util.inspect(body, true, 10, true))
            error.elasticsearchReply = body

            return cb(error)
        }
            var searchResults = {
                total: body.hits.total,
                hits: []
            }

        if (body.hits.hits && body.hits.hits.length) {
            searchResults.hits = body.hits.hits
        }

        return cb(null, searchResults)
    })
}

/**
 * Make a search request using `reqOpts`, normalize results and call `cb`.
 *
 * @param  {Object}   reqOpts
 * @param  {Function} cb
 */
exports.doAggAndNormalizeResults = function (searchUri, aggOpts, cb) {
    // merge `searchOpts` with default user-level search options
    searchOpts = exports.mergeAggOptions(aggOpts)

    var body = exports.mergeAggBody(aggOpts)
    

    var reqOpts = {
        method: 'POST',
        url: searchUri,
        body: JSON.stringify(body)
    }

    exports.backOffRequest(reqOpts, function (err, res, body) {
        if (err) {
            var error = new Error('Elasticsearch search error:'+util.inspect(err, true, 10, true))
            error.details = err

            return cb(error)
        }

        // console.log('\nsearch response body', util.inspect(body, true, 10, true))

        if (!body.hits) {
            var error = new Error('Unexpected Elasticsearch reply:'+util.inspect(body, true, 10, true))
            error.elasticsearchReply = body

            return cb(error)
        }

            var searchResults = {
                total: body.hits.total,
                aggregation: body.aggregations
            }

        if (body.hits.hits && body.hits.hits.length) {
            searchResults.hits = body.hits.hits
        }

        return cb(null, searchResults)
    })
}

/**
 * Make index name (with prefix) from `options`
 *
 * @param  {Object} options
 * @return {String}
 */
exports.makeIndexName = function (options) {
    return options.prefix ? (options.prefix + '-' + options.type) : options.type
}

/**
 * Form the elasticsearch URI for indexing/deleting a document
 *
 * @param  {Object} options
 * @param  {Mongoose document} doc
 * @return {String}
 */
exports.makeDocumentUri = function (options, doc) {
    var typeUri = exports.makeTypeUri(options)

    var docUri = typeUri+'/'+doc._id

    return docUri
}

/**
 * Form the elasticsearch URI up to the type of the document
 *
 * @param  {Object} options
 * @return {String}
 */
exports.makeTypeUri = function (options) {
    var indexUri = exports.makeIndexUri(options)

    var typeUri = indexUri + '/' + options.type

    return typeUri
}

/**
 * Form the elasticsearch URI up to the index of the document (index is same as type due to aliasing)
 * @param  {Object} options
 * @return {String}
 */
exports.makeIndexUri = function (options) {
    var domainUri = exports.makeDomainUri(options)

    var indexName = exports.makeIndexName(options)

    var indexUri = domainUri + '/' + indexName

    return indexUri
}

exports.makeDomainUri = function (options) {
    if(options.port){
        var domainUri = url.format({
            protocol: options.protocol,
            hostname: options.host,
            port: options.port
        })
    } else{
        var domainUri = url.format({
            protocol: options.protocol,
            hostname: options.host
        })
    }

    return domainUri
}

exports.makeAliasUri = function (options) {
    var domainUri = exports.makeDomainUri(options)

    var aliasUri = domainUri + '/_aliases'

    return aliasUri
}

exports.makeBulkIndexUri = function (indexName, options) {
    var domainUri = exports.makeDomainUri(options)

    var bulkIndexUri = domainUri + '/' + indexName + '/_bulk'

    return bulkIndexUri
}

// Checks that a response body from elasticsearch reported success
exports.elasticsearchBodyOk = function (elasticsearchBody) {
    // `ok` for elasticsearch version < 1, `acknowledged` for v1
    return elasticsearchBody && (elasticsearchBody.ok || elasticsearchBody.acknowledged || elasticsearchBody.total == elasticsearchBody.successful)
}