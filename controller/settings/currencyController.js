
const Currency = require("../../database/model/currency")
const Organization = require("../../database/model/organization")

const { cleanData } = require("../../services/cleanData");


// Get Currency 
exports.getCurrency = async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
  
      const currencies = await Currency.find({ organizationId:organizationId},{organizationId:0});
  
      if (currencies) {
        res.status(200).json(currencies);
      } else {
        res.status(404).json({ message: "Currencies not found" });
      }
    } catch (error) {
      console.log("Error fetching Currencies:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};
  
//get single currency
exports.viewCurrency = async (req, res) => {
    try {
      const { id } = req.params; 
  
      // Log the ID being fetched
      console.log("Fetching currency with ID:", id);
  
      const currency = await Currency.findById(id);
  
      if (currency) {
        res.status(200).json(currency);
      } else {
        res.status(404).json({ message: "Currency not found" });
      }
    } catch (error) {
      console.log("Error fetching currency:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};
  
// Add currency
exports.addCurrency = async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
      const cleanedData = cleanData(req.body);
      const { currencyCode, currencySymbol, currencyName, decimalPlaces, format  } = cleanedData;
  
      const organization = await Organization.findOne({ organizationId });
      if (!organization) {
        return res.status(404).json({ message: "Organization not found" });
      }
  
      const existingCurrency = await Currency.findOne({ organizationId, currencyCode });
      if (existingCurrency) {
        return res.status(400).json({ message: "Currency code already exists for this organization" });
      }
  

      const newCurrency = new Currency({
        organizationId,
        currencyCode,
        currencySymbol,
        currencyName,
        decimalPlaces,
        format,
        baseCurrency:false
      });
  
      await newCurrency.save();
  
      res.status(201).json("Currency added successfully");
    } catch (error) {
      console.log("Error adding Currency:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};
  
  // Edit currency
exports.editCurrency = async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
      const cleanedData = cleanData(req.body);
      const { currencyId, currencyCode, currencySymbol, currencyName, decimalPlaces, format } = cleanedData;
  
      const updatedCurrency = await Currency.findByIdAndUpdate(
        currencyId,
        { organizationId, currencyCode, currencySymbol, currencyName, decimalPlaces, format},
        { new: true }
      );
  
      if (updatedCurrency) {
        res.status(200).json("Currency updated successfully");
      } else {
        res.status(404).json({ message: "Currency not found" });
      }
    } catch (error) {
      console.log("Error editing Currency:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};
  
  
// Delete currency 
exports.deleteCurrency = async (req, res) => {
    try {
      const { currencyId } = req.params;
  
      // Fetch the currency by ID and organizationId
      const currency = await Currency.findOne({
        _id: currencyId
      });
  
      if (!currency) {
        return res.status(404).json({ message: "Currency not found" });
      }
  
      // Check if the baseCurrency is false
      if (currency.baseCurrency === false) {
        // Delete the currency
        await Currency.findOneAndDelete({
          _id: currencyId
        });
  
        res.status(200).json({ message: "Currency deleted successfully" });
      } else {
        // Reject the deletion if baseCurrency is true
        res.status(400).json({ message: "Cannot delete a base currency" });
      }
    } catch (error) {
      console.log("Error deleting Currency:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};
  